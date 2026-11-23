// PhantomDock content script orchestrator. Loads the matching site adapter,
// connects to the background via runtime.Port (never touches localhost), and
// drives the full turn lifecycle: stream detection -> batched approval cards ->
// guard checks -> cascading skill upload -> human-paced submission.

import type { AdapterDef } from '../adapters/schema';
import { validateAdapter } from '../adapters/schema';
import qwen from '../adapters/qwen.json';
import deepseek from '../adapters/deepseek.json';
import chatgpt from '../adapters/chatgpt.json';
import universal from '../adapters/universal.json';
import {
  DEFAULT_SETTINGS,
  type GuardSettings,
  type SkillSummary,
  type TabBinding,
  type ToolInfo,
  type ToolResultPayload,
  randomFromRange,
  sleep,
} from '../shared/protocol';
import { initialGuardState } from './guards';
import { GuardController } from './guards-runtime';
import { hydrateHistory } from './history';
import { findInput, insertText, readInputText, submitInput, type InputEl } from './injector';
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

interface RuntimeCtx {
  port: chrome.runtime.Port;
  adapter: AdapterDef;
  settings: GuardSettings;
  tools: ToolInfo[];
  skills: SkillSummary[];
  binding: TabBinding | null;
}

let ctx: RuntimeCtx | null = null;
let controlBar: ControlBar | null = null;
let observer: StreamObserver | null = null;
let guards: GuardController | null = null;
let trustedTools: string[] = [];
let activeBatch: TurnBatch | null = null;
let activeCards = new Map<string, ToolCard>();
let prependedThisThread = false;
let cachedManifest: { xml: string; tools: ToolInfo[] } | null = null;

function main(): void {
  const port = chrome.runtime.connect({ name: 'pdock-content' });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    void handlePortMessage(msg);
  });

  // Adapter selection: user overrides (persisted by bg) -> bundled -> universal.
  void (async () => {
    const adapter = await selectAdapter();
    if (!adapter) {
      console.info('[pdock] no enabled adapter for this host');
      return;
    }
    ctx = {
      port,
      adapter,
      settings: { ...DEFAULT_SETTINGS },
      tools: [],
      skills: [],
      binding: null,
    };
    // Full init arrives from the background as response to 'hello'.
    port.postMessage({ t: 'hello' });

    observer = new StreamObserver(adapter, {
      onToolTurn: (calls, assistantEl) => void handleToolTurn(calls, assistantEl),
      onToolResultUserMessage: (userEl) => collapseToolResultBubble(userEl, []),
    });
    observer.start();

    hydrateHistory(adapter);
    installManualSendHooks(adapter);
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
    adapters = res.adapters ?? { ...BUNDLED };
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

async function handlePortMessage(msg: Record<string, unknown>): Promise<void> {
  switch (msg.t) {
    case 'init': {
      if (!ctx) return;
      ctx.settings = (msg.settings as GuardSettings) ?? ctx.settings;
      ctx.binding = (msg.binding as TabBinding) ?? null;
      trustedTools = (msg.trustedTools as string[]) ?? [];
      const daemon = msg.daemon as
        | { info: unknown; tools: ToolInfo[]; skills: SkillSummary[]; connected: boolean }
        | null;
      if (daemon) {
        ctx.tools = daemon.tools ?? [];
        ctx.skills = daemon.skills ?? [];
      }
      initUi();
      // Prefetch the manifest so autoPrependFirstTurn can act synchronously.
      if (ctx.binding) {
        void requestManifest().then((m) => {
          cachedManifest = m;
        });
      }
      break;
    }
    case 'toolResult': {
      // Correlate to the awaiting card via its request id (id === call.id).
      const id = String(msg.id);
      const card = activeCards.get(id);
      if (card && msg.ok) {
        card.setResolved({
          call: card.call,
          approved: true,
          result: msg.result as ToolResultPayload,
        });
        activeBatch?.settle(card.call, true, (msg.result as ToolResultPayload) ?? null);
      } else if (card && !msg.ok) {
        card.setResolved({ call: card.call, approved: false, result: null });
        activeBatch?.settle(card.call, false, null);
      }
      // Popup-initiated calls resolve via their own runTool promise listeners.
      break;
    }
    case 'settingsChanged': {
      if (ctx && guards) {
        ctx.settings = msg.settings as GuardSettings;
        guards.updateSettings(ctx.settings);
      }
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
    case 'daemonDisconnected': {
      controlBar?.setBound(false);
      break;
    }
    default:
      break;
  }
}

function initUi(): void {
  if (!ctx || controlBar) return;
  controlBar = new ControlBar(
    {
      onAttachWorkspace: () => void attachWorkspace(),
      onAttachSkill: (name) => void attachSkillFromPopup(name),
      onStopToggle: (stopped) => {
        guards?.setStopped(stopped);
        ctx?.port.postMessage({ t: 'setStopped', stopped });
      },
    },
    ctx.skills,
    Boolean(ctx.binding),
  );
  if (ctx.binding) {
    controlBar.setBound(true, `:${ctx.binding.port}`);
  }

  guards = new GuardController(
    ctx.adapter,
    ctx.settings,
    {
      setBadge: () => undefined, // bg owns the action badge
      onStateChange: (s) => controlBar?.setGuardSummary(s),
    },
    () => undefined, // per-turn persistence flows through bg (turnSent)
    initialGuardState(),
  );
  guards.start();
}

// ---- workspace attachment ----

async function attachWorkspace(): Promise<void> {
  if (!ctx || !observer) return;
  const input = findInput(ctx.adapter);
  if (!input) return;
  const manifest = cachedManifest ?? (await requestManifest());
  if (!manifest) {
    controlBar?.setBound(false);
    return;
  }
  cachedManifest = manifest;
  ctx.tools = manifest.tools;
  insertText(input, manifest.xml, false);
  prependedThisThread = true;
}

function requestManifest(): Promise<{ xml: string; tools: ToolInfo[] } | null> {
  return new Promise((resolve) => {
    if (!ctx) return resolve(null);
    const id = `man_${Date.now()}`;
    const timer = setTimeout(() => resolve(null), 10000);
    const onMsg = (msg: Record<string, unknown>): void => {
      if (msg.t === 'manifestResult' && msg.id === id) {
        ctx?.port.onMessage.removeListener(onMsg as never);
        clearTimeout(timer);
        resolve({ xml: String(msg.xml), tools: msg.tools as ToolInfo[] });
      }
    };
    ctx.port.onMessage.addListener(onMsg as never);
    ctx.port.postMessage({ t: 'manifest', id });
  });
}

// ---- skill attachment (popup / control bar) ----

async function attachSkillFromPopup(name: string): Promise<void> {
  if (!ctx) return;
  const input = findInput(ctx.adapter);
  const result = await runTool('activate_skill', { name });
  if (!result) return;
  if (result.status === 'upload_ready' && result.delivery?.mode === 'upload' && input) {
    await attachSkillFile(
      ctx.adapter,
      input,
      result.delivery.filename,
      result.delivery.content,
    );
  } else if (result.delivery?.mode === 'inline_part') {
    if (input) insertText(input, result.text, false);
  }
}

function runTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResultPayload | null> {
  return new Promise((resolve) => {
    if (!ctx) return resolve(null);
    const id = `call_${tool}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const timer = setTimeout(() => resolve(null), 30000);
    const onMsg = (msg: Record<string, unknown>): void => {
      if (msg.t === 'toolResult' && msg.id === id) {
        ctx?.port.onMessage.removeListener(onMsg as never);
        clearTimeout(timer);
        if (msg.ok) {
          resolve(msg.result as ToolResultPayload);
        } else {
          console.warn('[pdock] tool error:', msg.error);
          resolve(null);
        }
      }
    };
    ctx.port.onMessage.addListener(onMsg as never);
    ctx.port.postMessage({ t: 'toolCall', id, tool, args });
  });
}

// ---- turn lifecycle ----

async function handleToolTurn(calls: ParsedCall[], assistantEl: HTMLElement | null): Promise<void> {
  if (!ctx || !observer || activeBatch) return;
  observer.pause();
  controlBar?.setStreamingBadge(false);

  const batch = new TurnBatch(calls, (resolved) => void deliverTurnReply(resolved));
  activeBatch = batch;
  activeCards = new Map();

  const callbacks = {
    onApprove: (call: ParsedCall) => void executeCall(call),
    onReject: (call: ParsedCall) => {
      activeCards.get(call.id)?.setResolved({ call, approved: false, result: null });
      batch.settle(call, false, null);
    },
    onTrustSession: (call: ParsedCall) => {
      trustedTools.push(call.name);
      ctx?.port.postMessage({ t: 'trustTool', tool: call.name });
      void executeCall(call);
    },
  };

  for (const call of calls) {
    const info = ctx.tools.find((t) => t.name === call.name) ?? null;
    const card = new ToolCard(call, info, callbacks, assistantEl);
    activeCards.set(call.id, card);
    card.setStatusLine(batch.statusLine());

    const autoApprove =
      trustedTools.includes(call.name) ||
      (ctx.settings.autoApproveReadOnly &&
        info !== null &&
        info.readonly &&
        (info.category === 'fs' || info.category === 'skill'));
    if (autoApprove) {
      await sleep(120);
      void executeCall(call);
    }
  }
}

async function executeCall(call: ParsedCall): Promise<void> {
  if (!ctx) return;
  const result = await runTool(call.name, call.args);
  if (!result) {
    const card = activeCards.get(call.id);
    card?.setResolved({ call, approved: false, result: null });
    activeBatch?.settle(call, false, null);
    return;
  }
  // Success path: the toolResult port handler resolves card + batch.
  // Null-check safety for orphaned ids (already settled batches are no-ops).
  if (!activeBatch?.isResolved(call) && !activeCards.has(call.id)) {
    activeBatch?.settle(call, true, result);
  }
}

async function deliverTurnReply(resolved: ResolvedCall[]): Promise<void> {
  if (!ctx || !observer || !guards) return;

  // Wait for guards to clear (active-tab gate, challenge, budgets, cooldown).
  for (;;) {
    const verdict = guards.check();
    if (verdict.ok) break;
    await sleep(1000);
  }

  const input = findInput(ctx.adapter);
  if (!input) {
    cleanupTurn();
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
        // Re-request as inline part 1 via the daemon.
        const skillName = String(r.call.args.name ?? '');
        const inline = await runTool('activate_skill', { name: skillName, mode: 'inline' });
        finalized.push(
          inline
            ? { call: r.call, approved: true, result: inline }
            : { call: r.call, approved: false, result: null },
        );
        continue;
      }
    }
    finalized.push(r);
  }

  const reply = composeTurnReply(finalized);

  // Human-paced: inter-turn cooldown jitter, then insert + submit.
  await sleep(randomFromRange(ctx.settings.interTurnDelayRangeMs));
  const inserted = insertText(input, reply, true);
  if (!inserted) {
    cleanupTurn();
    return;
  }
  await submitInput(ctx.adapter, ctx.settings);
  guards.registerAutoSend();
  ctx.port.postMessage({ t: 'turnSent' });

  // The observer fires onToolResultUserMessage for the new bubble (pill
  // collapse); resume watching for the next assistant turn.
  cleanupTurn();
}

function cleanupTurn(): void {
  activeBatch = null;
  activeCards = new Map();
  observer?.resume();
}

// ---- manual-send hooks (budget reset + auto-prepend) ----

function installManualSendHooks(adapter: AdapterDef): void {
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest(adapter.selectors.sendButton);
      if (!btn) return;
      // Manual send resets the consecutive auto-turn counter.
      ctx?.port.postMessage({ t: 'manualSent' });
      guards?.registerManualSend();

      // autoPrependFirstTurn: synchronously inject the cached manifest ahead
      // of the user's first prompt (capture phase runs before React handlers).
      if (
        ctx &&
        ctx.binding &&
        ctx.settings.autoPrependFirstTurn &&
        !prependedThisThread &&
        cachedManifest &&
        threadIsEmpty()
      ) {
        const input = findInput(adapter) as InputEl | null;
        const current = input ? readInputText(input).trim() : '';
        if (input && current) {
          ctx.tools = cachedManifest.tools;
          insertText(input, `${cachedManifest.xml}\n\n${current}`, true);
          prependedThisThread = true;
        }
      }
    },
    { capture: true, passive: true },
  );
}

function threadIsEmpty(): boolean {
  if (!ctx) return false;
  const users = document.querySelectorAll(ctx.adapter.selectors.userMessage);
  return users.length <= 1; // at most the message currently being composed
}

main();
