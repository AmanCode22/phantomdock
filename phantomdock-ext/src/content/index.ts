// PhantomDock content script orchestrator.
// - Resilient PortClient with auto-reconnect across MV3 service-worker sleep
// - Live binding/unbind & adapter hot-reload without page refresh
// - Deterministic tool-call execution (single correlation path, zero ID mismatch)
// - SPA thread-change reset + snapshot-before-submit so fast replies never drop
// - Manual-send hooks for both Send button click and Enter key

import type { AdapterDef } from '../adapters/schema';
import { validateAdapter } from '../adapters/schema';
import qwen from '../adapters/qwen.json';
import deepseek from '../adapters/deepseek.json';
import chatgpt from '../adapters/chatgpt.json';
import universal from '../adapters/universal.json';
import {
  DEFAULT_SETTINGS,
  nextRequestId,
  randomFromRange,
  sleep,
  type DaemonSnapshot,
  type DiagnosticReport,
  type GuardSettings,
  type SkillSummary,
  type TabBinding,
  type ToolInfo,
  type ToolResultPayload,
} from '../shared/protocol';
import { initialGuardState, type GuardRuntimeState } from './guards';
import { GuardController } from './guards-runtime';
import { callKey, hydrateHistory } from './history';
import {
  findInput,
  findSendButton,
  insertText,
  readInputText,
  submitInput,
  type InputEl,
} from './injector';
import { StreamObserver } from './observer';
import { composeTurnReply, type ParsedCall, type ResolvedCall } from './parser';
import { TurnBatch } from './turn';
import { attachSkillFile } from './uploader';
import { ControlBar } from './ui/ControlBar';
import { ToolCard } from './ui/ToolCard';
import { collapseToolResultBubble } from './ui/ResultPill';

const BUNDLED: Record<string, unknown> = {
  'qwen-chat': qwen,
  'deepseek-chat': deepseek,
  chatgpt: chatgpt,
  'universal-fallback': universal,
};

// Prevent double initialization if injected via scripting.executeScript on a
// page that already has the content script loaded.
const INIT_FLAG = '__pdock_content_initialized__';

// ---------------------------------------------------------------------------
// Resilient PortClient: survives MV3 service-worker sleep/restarts and owns
// all request/response correlation cleanly (no leaked listeners).
// ---------------------------------------------------------------------------

interface PendingPortReq {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class PortClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, PendingPortReq>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private invalidated = false;

  constructor(
    private onEvent: (msg: Record<string, unknown>) => void,
    private onInvalidated: () => void,
  ) {}

  connect(): void {
    if (this.invalidated) return;
    if (this.port) return;
    try {
      const p = chrome.runtime.connect({ name: 'pdock-content' });
      this.port = p;
      p.onMessage.addListener((msg: Record<string, unknown>) => {
        const id = typeof msg.id === 'string' ? msg.id : null;
        if (id && this.pending.has(id) && (msg.t === 'toolResult' || msg.t === 'manifestResult')) {
          const entry = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
          return;
        }
        this.onEvent(msg);
      });
      p.onDisconnect.addListener(() => {
        this.port = null;
        this.failPending('Extension background disconnected — reconnecting…');
        // Check if extension was reloaded/updated (chrome.runtime.id becomes undefined).
        if (!chrome.runtime?.id) {
          this.invalidated = true;
          this.stopKeepalive();
          this.onInvalidated();
          return;
        }
        this.scheduleReconnect();
      });
      p.postMessage({ t: 'hello' });
      this.startKeepalive();
    } catch {
      this.invalidated = true;
      this.onInvalidated();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.invalidated) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 600);
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.port) {
        try {
          this.port.postMessage({ t: 'ping' });
        } catch {
          this.port = null;
          this.scheduleReconnect();
        }
      }
    }, 20_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  post(msg: Record<string, unknown>): boolean {
    if (this.invalidated) return false;
    if (!this.port) {
      this.connect();
    }
    if (!this.port) return false;
    try {
      this.port.postMessage(msg);
      return true;
    } catch {
      this.port = null;
      this.scheduleReconnect();
      return false;
    }
  }

  request(
    msg: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = nextRequestId(String(msg.t ?? 'req'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s — daemon did not answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.post({ ...msg, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Extension background is unavailable — try reloading the tab'));
      }
    });
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Content Orchestrator State
// ---------------------------------------------------------------------------

interface RuntimeCtx {
  client: PortClient;
  adapter: AdapterDef;
  settings: GuardSettings;
  tools: ToolInfo[];
  skills: SkillSummary[];
  binding: TabBinding | null;
  connected: boolean;
}

let ctx: RuntimeCtx | null = null;
let controlBar: ControlBar | null = null;
let observer: StreamObserver | null = null;
let guards: GuardController | null = null;
let trustedTools: string[] = [];
let activeBatch: TurnBatch | null = null;
let activeCards = new Map<string, ToolCard>();
let activeTurnGeneration = 0;
let prependedThisThread = false;
let cachedManifest: { xml: string; tools: ToolInfo[] } | null = null;
const firedCallKeys = new Set<string>();

function main(): void {
  const win = window as unknown as Record<string, unknown>;
  if (win[INIT_FLAG]) return;
  win[INIT_FLAG] = true;

  void (async () => {
    const adapter = await selectAdapter();
    if (!adapter) {
      console.info('[pdock] no enabled adapter for this host');
      return;
    }

    const client = new PortClient(
      (msg) => void handlePortMessage(msg),
      () => {
        controlBar?.setBound(false);
        controlBar?.showToast(
          'PhantomDock was updated — refresh this tab to reconnect.',
          'err',
          10_000,
        );
      },
    );

    ctx = {
      client,
      adapter,
      settings: { ...DEFAULT_SETTINGS },
      tools: [],
      skills: [],
      binding: null,
      connected: false,
    };

    initUi();
    client.connect();

    observer = new StreamObserver(adapter, {
      onToolTurn: (calls, assistantEl) => void handleToolTurn(calls, assistantEl),
      onToolResultUserMessage: (userEl, names) => {
        collapseToolResultBubble(userEl, names);
      },
      onStreamingChange: (streaming) => {
        controlBar?.setStreamingBadge(streaming);
      },
      onThreadChange: () => {
        handleThreadChange();
      },
    });
    observer.start();

    hydrateHistory(adapter).firedKeys.forEach((k) => firedCallKeys.add(k));
    observer.snapshotLastAssistant();
    installManualSendHooks();
  })();
}

async function selectAdapter(): Promise<AdapterDef | null> {
  const host = location.hostname;
  let adapters: Record<string, unknown>;
  try {
    const res = (await chrome.runtime.sendMessage({ t: 'getAdapters' })) as {
      ok: boolean;
      adapters: Record<string, unknown>;
    };
    adapters = res?.adapters ?? { ...BUNDLED };
  } catch {
    adapters = { ...BUNDLED };
  }

  const defs: AdapterDef[] = [];
  for (const v of Object.values(adapters)) {
    const res = validateAdapter(v);
    if (res.ok) defs.push(res.def);
  }

  const exact = defs
    .filter(
      (d) =>
        d.enabled &&
        d.hostMatch.some((m) => m !== '*' && (host === m || host.endsWith(`.${m}`))),
    )
    .sort((a) => (a.id === 'universal-fallback' ? 1 : 0));
  if (exact.length) return exact[0];
  const fallback = defs.find((d) => d.enabled && d.hostMatch.includes('*'));
  return fallback ?? null;
}

function applyDaemonState(binding: TabBinding | null, daemon: DaemonSnapshot | null): void {
  if (!ctx) return;
  ctx.binding = binding;
  ctx.connected = Boolean(binding && daemon?.connected);
  ctx.tools = daemon?.tools ?? [];
  ctx.skills = daemon?.skills ?? [];

  if (ctx.connected && binding) {
    controlBar?.setBound(true, `:${binding.port}`);
    controlBar?.setSkills(ctx.skills);
    // Prefetch manifest so Attach Workspace & autoPrependFirstTurn are instant.
    void requestManifest().then((m) => {
      if (m) {
        cachedManifest = m;
        if (ctx) ctx.tools = m.tools;
      }
    });
  } else {
    cachedManifest = null;
    controlBar?.setBound(false);
    controlBar?.setSkills([]);
  }
}

async function handlePortMessage(msg: Record<string, unknown>): Promise<void> {
  if (!ctx) return;
  switch (msg.t) {
    case 'init': {
      ctx.settings = (msg.settings as GuardSettings) ?? ctx.settings;
      trustedTools = (msg.trustedTools as string[]) ?? [];
      guards?.updateSettings(ctx.settings);
      if (msg.turnState) {
        guards?.hydrateState(msg.turnState as GuardRuntimeState);
      }
      applyDaemonState(
        (msg.binding as TabBinding | null) ?? null,
        (msg.daemon as DaemonSnapshot | null) ?? null,
      );
      break;
    }
    case 'bindingUpdated': {
      const binding = (msg.binding as TabBinding | null) ?? null;
      const daemon = (msg.daemon as DaemonSnapshot | null) ?? null;
      applyDaemonState(binding, daemon);
      if (binding && daemon?.connected) {
        controlBar?.showToast(`Paired with pdock :${binding.port}`, 'ok');
      } else if (!binding) {
        controlBar?.showToast('Unbound from pdock', 'info');
      }
      break;
    }
    case 'daemonConnected': {
      const daemon = (msg.daemon as DaemonSnapshot | null) ?? null;
      if (ctx.binding && daemon) {
        applyDaemonState(ctx.binding, daemon);
        controlBar?.showToast(`Reconnected to pdock :${ctx.binding.port}`, 'ok');
      }
      break;
    }
    case 'daemonDisconnected': {
      ctx.connected = false;
      controlBar?.setBound(false);
      controlBar?.showToast('pdock daemon disconnected', 'err');
      break;
    }
    case 'settingsChanged': {
      ctx.settings = msg.settings as GuardSettings;
      guards?.updateSettings(ctx.settings);
      break;
    }
    case 'stopChanged': {
      guards?.setStopped(Boolean(msg.stopped));
      break;
    }
    case 'attachSkill': {
      await attachSkillFromPopup(String(msg.name));
      break;
    }
    case 'adaptersChanged': {
      const fresh = await selectAdapter();
      if (fresh && ctx) {
        ctx.adapter = fresh;
        observer?.updateAdapter(fresh);
        guards?.updateAdapter(fresh);
        controlBar?.showToast(`Reloaded adapter: ${fresh.name}`, 'ok');
      }
      break;
    }
    case 'diagnose': {
      const report = buildDiagnosticReport();
      ctx.client.post({ t: 'diagnoseResult', id: msg.id, report });
      break;
    }
    default:
      break;
  }
}

function buildDiagnosticReport(): DiagnosticReport {
  const a = ctx!.adapter;
  let assistantCount = 0;
  let userCount = 0;
  try {
    assistantCount = document.querySelectorAll(a.selectors.assistantMessage).length;
  } catch {
    /* ignore */
  }
  try {
    userCount = document.querySelectorAll(a.selectors.userMessage).length;
  } catch {
    /* ignore */
  }
  return {
    adapterId: a.id,
    adapterName: a.name,
    host: location.hostname,
    bound: Boolean(ctx?.connected),
    inputFound: Boolean(findInput(a)),
    sendButtonFound: Boolean(findSendButton(a)),
    assistantCount,
    userCount,
    streaming: observer?.isStreamingNow() ?? false,
    challengeVisible: guards?.isChallengeVisible() ?? false,
    rateLimitVisible: guards?.isRateLimitVisible() ?? false,
  };
}

function initUi(): void {
  if (!ctx || controlBar) return;
  controlBar = new ControlBar(
    {
      onAttachWorkspace: () => void attachWorkspace(),
      onAttachSkill: (name) => void attachSkillFromPopup(name),
      onStopToggle: (stopped) => {
        guards?.setStopped(stopped);
        ctx?.client.post({ t: 'setStopped', stopped });
      },
      onCancelBatch: () => {
        cancelActiveTurn('Current tool batch cancelled.');
      },
    },
    ctx.skills,
    ctx.connected,
  );

  guards = new GuardController(
    ctx.adapter,
    ctx.settings,
    {
      setBadge: () => undefined, // bg owns the action badge
      onStateChange: (s) => controlBar?.setGuardSummary(s),
    },
    (until, streak, reason) => {
      ctx?.client.post({ t: 'cooldownTripped', until, streak, reason });
    },
    initialGuardState(),
  );
  guards.start();
}

function handleThreadChange(): void {
  cancelActiveTurn();
  prependedThisThread = false;
  firedCallKeys.clear();
  if (!ctx || !observer) return;
  // Give the SPA a moment to render the new thread's history before snapshotting.
  setTimeout(() => {
    if (!ctx || !observer) return;
    hydrateHistory(ctx.adapter).firedKeys.forEach((k) => firedCallKeys.add(k));
    observer.snapshotLastAssistant();
  }, 600);
}

function cancelActiveTurn(toastMsg?: string): void {
  activeTurnGeneration += 1;
  for (const card of activeCards.values()) {
    card.remove();
  }
  activeCards.clear();
  activeBatch = null;
  controlBar?.setBatchActive(false);
  observer?.resume(true);
  if (toastMsg) {
    controlBar?.showToast(toastMsg, 'info');
  }
}

// ---- workspace attachment ----

async function attachWorkspace(): Promise<void> {
  if (!ctx) return;
  if (!ctx.binding || !ctx.connected) {
    controlBar?.showToast('Not paired — click the PhantomDock icon to pair with pdock.', 'err');
    return;
  }
  const input = findInput(ctx.adapter);
  if (!input) {
    controlBar?.showToast(`Chat input not found for adapter "${ctx.adapter.name}".`, 'err');
    return;
  }
  const manifest = cachedManifest ?? (await requestManifest());
  if (!manifest) {
    controlBar?.showToast('Could not fetch workspace manifest from pdock.', 'err');
    return;
  }
  cachedManifest = manifest;
  ctx.tools = manifest.tools;
  const ok = insertText(
    input,
    `${manifest.xml}\n\n(Silent workspace context — do not reply to this message. Wait for the user's actual request.)`,
    false,
  );
  if (ok) {
    prependedThisThread = true;
    controlBar?.showToast('Workspace context inserted into chat input.', 'ok');
  } else {
    controlBar?.showToast('Failed to insert workspace context into input.', 'err');
  }
}

async function requestManifest(): Promise<{ xml: string; tools: ToolInfo[] } | null> {
  if (!ctx) return null;
  try {
    const res = await ctx.client.request({ t: 'manifest' }, 10_000);
    if (res.ok && typeof res.xml === 'string') {
      return { xml: res.xml, tools: (res.tools as ToolInfo[]) ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- skill attachment (popup / control bar) ----

async function attachSkillFromPopup(name: string): Promise<void> {
  if (!ctx) return;
  if (!ctx.binding || !ctx.connected) {
    controlBar?.showToast('Pair with pdock before attaching a skill.', 'err');
    return;
  }
  const input = findInput(ctx.adapter);
  const result = await runTool('activate_skill', { name });
  if (result.status === 'error') {
    controlBar?.showToast(result.text, 'err');
    return;
  }
  if (result.status === 'upload_ready' && result.delivery?.mode === 'upload' && input) {
    const outcome = await attachSkillFile(
      ctx.adapter,
      input,
      result.delivery.filename,
      result.delivery.content,
    );
    if (outcome.mode === 'upload') {
      controlBar?.showToast(`Attached ${result.delivery.filename}`, 'ok');
    } else {
      const inline = await runTool('activate_skill', { name, mode: 'inline' });
      if (inline.status !== 'error') {
        insertText(input, inline.text, false);
        controlBar?.showToast(`Inserted ${name} inline (upload fallback).`, 'ok');
      } else {
        controlBar?.showToast(inline.text, 'err');
      }
    }
  } else if (result.delivery?.mode === 'inline_part' && input) {
    insertText(input, result.text, false);
    controlBar?.showToast(`Inserted ${name} inline.`, 'ok');
  }
}

function errorPayload(text: string): ToolResultPayload {
  return { status: 'error', text, delivery: null };
}

async function runTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResultPayload> {
  if (!ctx) return errorPayload('PhantomDock is not initialized');
  try {
    const res = await ctx.client.request({ t: 'toolCall', tool, args }, 180_000);
    if (res.ok && res.result) {
      return res.result as ToolResultPayload;
    }
    return errorPayload(String(res.error ?? 'Tool execution failed'));
  } catch (e) {
    return errorPayload(e instanceof Error ? e.message : String(e));
  }
}

// ---- turn lifecycle ----

async function handleToolTurn(calls: ParsedCall[], assistantEl: HTMLElement | null): Promise<void> {
  if (!ctx || !observer || activeBatch) return;
  if (!ctx.binding) {
    controlBar?.showToast('Tool call detected, but this tab is not paired with pdock.', 'err');
    return;
  }

  const fresh = calls.filter((c) => !firedCallKeys.has(callKey(c)));
  if (!fresh.length) return;
  for (const c of fresh) firedCallKeys.add(callKey(c));

  observer.pause();
  controlBar?.setStreamingBadge(false);
  controlBar?.setBatchActive(true);

  const generation = ++activeTurnGeneration;
  const batch = new TurnBatch(fresh, (resolved) => {
    void deliverTurnReply(resolved, generation);
  });
  activeBatch = batch;
  activeCards = new Map();

  const updateAllStatusLines = (): void => {
    const line = batch.statusLine();
    for (const card of activeCards.values()) {
      card.setStatusLine(line);
    }
  };

  const callbacks = {
    onApprove: (call: ParsedCall) => void executeCall(call, batch, generation, updateAllStatusLines),
    onReject: (call: ParsedCall) => {
      if (generation !== activeTurnGeneration) return;
      activeCards.get(call.id)?.setResolved({ call, approved: false, result: null });
      batch.settle(call, false, null);
      updateAllStatusLines();
    },
    onTrustSession: (call: ParsedCall) => {
      if (!trustedTools.includes(call.name)) {
        trustedTools.push(call.name);
      }
      ctx?.client.post({ t: 'trustTool', tool: call.name });
      void executeCall(call, batch, generation, updateAllStatusLines);
    },
  };

  for (const call of fresh) {
    const info = ctx.tools.find((t) => t.name === call.name) ?? null;
    const card = new ToolCard(call, info, callbacks, assistantEl);
    activeCards.set(call.id, card);
    card.setStatusLine(batch.statusLine());

    const autoApprove =
      trustedTools.includes(call.name) ||
      (ctx.settings.autoApproveReadOnly &&
        info !== null &&
        info.readonly &&
        (info.category === 'fs' || info.category === 'skill' || call.name === 'list_mcp_tools'));

    if (autoApprove) {
      card.setRunning();
      await sleep(120);
      if (generation !== activeTurnGeneration) return;
      void executeCall(call, batch, generation, updateAllStatusLines);
    }
  }
}

async function executeCall(
  call: ParsedCall,
  batch: TurnBatch,
  generation: number,
  updateStatusLines: () => void,
): Promise<void> {
  if (!ctx || generation !== activeTurnGeneration) return;
  const result = await runTool(call.name, call.args);
  if (generation !== activeTurnGeneration) return;

  activeCards.get(call.id)?.setResolved({ call, approved: true, result });
  batch.settle(call, true, result);
  updateStatusLines();
}

async function deliverTurnReply(resolved: ResolvedCall[], generation: number): Promise<void> {
  if (!ctx || !observer || !guards) return;

  // Wait for guards to clear (active-tab gate, challenge, budgets, cooldown),
  // aborting cleanly if the user cancels the turn or navigates away.
  for (;;) {
    if (generation !== activeTurnGeneration) return;
    const verdict = guards.check();
    if (verdict.ok) break;
    await sleep(1000);
  }
  if (generation !== activeTurnGeneration) return;

  const input = findInput(ctx.adapter);
  if (!input) {
    controlBar?.showToast('Could not find chat input to send tool result.', 'err');
    cleanupTurn(false);
    return;
  }

  // Skill attachments first (upload cascade), with inline fallback re-fetch.
  const finalized: ResolvedCall[] = [];
  for (const r of resolved) {
    if (
      r.approved &&
      r.result?.status === 'upload_ready' &&
      r.result.delivery?.mode === 'upload'
    ) {
      const d = r.result.delivery;
      const outcome = await attachSkillFile(ctx.adapter, input, d.filename, d.content);
      if (outcome.mode === 'inline') {
        const skillName = String(r.call.args.name ?? '');
        const inline = await runTool('activate_skill', { name: skillName, mode: 'inline' });
        finalized.push({ call: r.call, approved: true, result: inline });
        continue;
      }
    }
    finalized.push(r);
  }
  if (generation !== activeTurnGeneration) return;

  const reply = composeTurnReply(finalized);

  // Human-paced inter-turn delay.
  await sleep(randomFromRange(ctx.settings.interTurnDelayRangeMs));
  if (generation !== activeTurnGeneration) return;

  // Snapshot the previous assistant message BEFORE submitting so a fast model
  // reply is never swallowed by resume().
  observer.snapshotLastAssistant();

  const inserted = insertText(input, reply, ctx.adapter.inputBehavior.clearBeforeInsert);
  if (!inserted) {
    controlBar?.showToast('Failed to insert tool result into chat input.', 'err');
    cleanupTurn(false);
    return;
  }

  const submitted = await submitInput(ctx.adapter, ctx.settings);
  if (!submitted) {
    controlBar?.showToast('Tool result inserted — click Send to submit.', 'info');
  } else {
    guards.registerAutoSend();
    ctx.client.post({ t: 'turnSent' });
  }

  cleanupTurn(false);
}

function cleanupTurn(snapshotNow: boolean): void {
  activeBatch = null;
  controlBar?.setBatchActive(false);
  // Keep resolved cards visible for easy inspection; clear map so next turn starts fresh.
  activeCards = new Map();
  observer?.resume(snapshotNow);
}

// ---- manual-send hooks (budget reset + auto-prepend) ----

function onManualSendAttempt(): void {
  if (!ctx) return;
  ctx.client.post({ t: 'manualSent' });
  guards?.registerManualSend();

  if (
    ctx.binding &&
    ctx.connected &&
    ctx.settings.autoPrependFirstTurn &&
    !prependedThisThread &&
    cachedManifest &&
    threadIsEmpty()
  ) {
    const input = findInput(ctx.adapter) as InputEl | null;
    const current = input ? readInputText(input).trim() : '';
    if (input && current && !current.includes('<workspace_context')) {
      ctx.tools = cachedManifest.tools;
      insertText(input, `${cachedManifest.xml}\n\n${current}`, true);
      prependedThisThread = true;
    }
  }
}

function installManualSendHooks(): void {
  document.addEventListener(
    'click',
    (ev) => {
      if (!ctx) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      try {
        if (!target.closest(ctx.adapter.selectors.sendButton)) return;
      } catch {
        return;
      }
      onManualSendAttempt();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'keydown',
    (ev) => {
      if (!ctx) return;
      if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.isComposing) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      try {
        if (!target.closest(ctx.adapter.selectors.inputBox)) return;
      } catch {
        return;
      }
      onManualSendAttempt();
    },
    { capture: true, passive: true },
  );
}

function threadIsEmpty(): boolean {
  if (!ctx) return false;
  try {
    const users = document.querySelectorAll(ctx.adapter.selectors.userMessage);
    return users.length <= 1;
  } catch {
    return false;
  }
}

main();
