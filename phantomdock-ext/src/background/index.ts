// PhantomDock background context: the single owner of all localhost traffic.
// Routes messages between content scripts (runtime.Port), the popup
// (runtime.onMessage), and the pdock daemon (WebSocket).

import qwen from '../adapters/qwen.json';
import deepseek from '../adapters/deepseek.json';
import chatgpt from '../adapters/chatgpt.json';
import gemini from '../adapters/gemini.json';
import kimi from '../adapters/kimi.json';
import universal from '../adapters/universal.json';
import { validateAdapter } from '../adapters/schema';
import {
  nextRequestId,
  type BgRequest,
  type DiagnosticReport,
  type GuardSettings,
  type HandshakeInfo,
  type SkillSummary,
  type ToolInfo,
} from '../shared/protocol';
import * as store from './storage';
import { scanForDaemons } from './scanner';
import { DaemonConnection } from './wsclient';

const BUNDLED_ADAPTERS: Record<string, unknown> = {
  'qwen-chat': qwen,
  'deepseek-chat': deepseek,
  chatgpt: chatgpt,
  gemini: gemini,
  kimi: kimi,
  'universal-fallback': universal,
};

// ---- daemon connection pool (one WS per port) ----

const connections = new Map<number, DaemonConnection>();
const contentPorts = new Map<number, chrome.runtime.Port>();
const pendingDiagnostics = new Map<
  string,
  { resolve: (r: DiagnosticReport | null) => void; timer: ReturnType<typeof setTimeout> }
>();

function sendToTab(tabId: number, msg: unknown): boolean {
  const port = contentPorts.get(tabId);
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    contentPorts.delete(tabId);
    return false;
  }
}

function broadcastToContent(msg: unknown): void {
  for (const [tabId, port] of contentPorts.entries()) {
    try {
      port.postMessage(msg);
    } catch {
      contentPorts.delete(tabId);
    }
  }
}

async function notifyBoundTabsForPort(portNum: number, msg: unknown): Promise<void> {
  const bindings = await store.getBindings();
  for (const [tabIdStr, binding] of Object.entries(bindings)) {
    if (binding.port === portNum) {
      sendToTab(Number(tabIdStr), msg);
    }
  }
}

function notifySettings(settings: GuardSettings): void {
  broadcastToContent({ t: 'settingsChanged', settings });
}

async function ensureConnection(port: number, token: string): Promise<DaemonConnection> {
  const existing = connections.get(port);
  if (existing && existing.token === token) {
    if (!existing.connected) {
      await existing.connect();
    }
    return existing;
  }
  existing?.close();
  const conn = new DaemonConnection(port, token, {
    onHello: (p, _hello) => {
      void notifyBoundTabsForPort(p, {
        t: 'daemonConnected',
        port: p,
        daemon: conn.snapshot(),
      });
    },
    onDisconnect: (p) => {
      void notifyBoundTabsForPort(p, { t: 'daemonDisconnected', port: p });
    },
  });
  connections.set(port, conn);
  try {
    await conn.connect();
  } catch (e) {
    if (connections.get(port) === conn) {
      connections.delete(port);
    }
    throw e;
  }
  return conn;
}

async function maybeCloseConnection(port: number): Promise<void> {
  const bindings = await store.getBindings();
  const inUse = Object.values(bindings).some((b) => b.port === port);
  if (!inUse) {
    connections.get(port)?.close();
    connections.delete(port);
  }
}

// ---- content script ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pdock-content') return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }
  contentPorts.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (contentPorts.get(tabId) === port) {
      contentPorts.delete(tabId);
    }
  });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    void handleContentMessage(tabId, port, msg);
  });
});

async function handleContentMessage(
  tabId: number,
  port: chrome.runtime.Port,
  msg: Record<string, unknown>,
): Promise<void> {
  const send = (m: unknown): void => {
    try {
      port.postMessage(m);
    } catch {
      if (contentPorts.get(tabId) === port) {
        contentPorts.delete(tabId);
      }
    }
  };

  try {
    switch (msg.t) {
      case 'ping': {
        send({ t: 'pong', ts: Date.now() });
        break;
      }
      case 'hello': {
        const [binding, settings, trusted, turnState] = await Promise.all([
          store.getBinding(tabId),
          store.getSettings(),
          store.getTrustedTools(tabId),
          store.getTurnState(tabId),
        ]);
        if (binding) {
          const conn = await ensureConnection(binding.port, binding.token).catch(() => null);
          send({
            t: 'init',
            binding,
            settings,
            trustedTools: trusted,
            turnState,
            daemon: conn ? conn.snapshot() : null,
          });
        } else {
          send({
            t: 'init',
            binding: null,
            settings,
            trustedTools: trusted,
            turnState,
            daemon: null,
          });
        }
        break;
      }
      case 'toolCall': {
        const binding = await store.getBinding(tabId);
        if (!binding) {
          send({ t: 'toolResult', id: msg.id, ok: false, error: 'No daemon bound to this tab' });
          return;
        }
        const conn = await ensureConnection(binding.port, binding.token).catch(() => null);
        if (!conn || !conn.connected) {
          send({ t: 'toolResult', id: msg.id, ok: false, error: 'Daemon not connected' });
          return;
        }
        const result = await conn.requestToolCall(
          String(msg.tool),
          (msg.args as Record<string, unknown>) ?? {},
        );
        send({ t: 'toolResult', id: msg.id, ok: true, result });
        break;
      }
      case 'manifest': {
        const binding = await store.getBinding(tabId);
        if (!binding) {
          send({ t: 'manifestResult', id: msg.id, ok: false, error: 'No daemon bound' });
          return;
        }
        const conn = await ensureConnection(binding.port, binding.token).catch(() => null);
        if (!conn || !conn.connected) {
          send({ t: 'manifestResult', id: msg.id, ok: false, error: 'Daemon not connected' });
          return;
        }
        const m = await conn.requestManifest();
        send({ t: 'manifestResult', id: msg.id, ok: true, xml: m.xml, tools: m.tools });
        break;
      }
      case 'turnSent': {
        const state = await store.getTurnState(tabId);
        state.consecutiveAutoTurns += 1;
        state.backoffStreak = 0;
        state.cooldownReason = null;
        const cutoff = Date.now() - 60 * 60 * 1000;
        state.hourlyTimestamps = [
          ...state.hourlyTimestamps.filter((ts) => ts >= cutoff),
          Date.now(),
        ];
        await store.putTurnState(tabId, state);
        break;
      }
      case 'manualSent': {
        const state = await store.getTurnState(tabId);
        state.consecutiveAutoTurns = 0;
        await store.putTurnState(tabId, state);
        break;
      }
      case 'cooldownTripped': {
        const state = await store.getTurnState(tabId);
        state.cooldownUntil = Number(msg.until) || 0;
        state.backoffStreak = Number(msg.streak) || state.backoffStreak + 1;
        state.cooldownReason = String(msg.reason ?? 'cooldown');
        await store.putTurnState(tabId, state);
        break;
      }
      case 'setStopped': {
        const state = await store.getTurnState(tabId);
        const stopped = Boolean(msg.stopped);
        state.stopped = stopped;
        if (!stopped) {
          state.cooldownUntil = 0;
          state.backoffStreak = 0;
          state.cooldownReason = null;
        }
        await store.putTurnState(tabId, state);
        void chrome.action.setBadgeText({ tabId, text: stopped ? 'STOP' : '' });
        break;
      }
      case 'trustTool': {
        await store.addTrustedTool(tabId, String(msg.tool));
        break;
      }
      case 'getTurnState': {
        const state = await store.getTurnState(tabId);
        send({ t: 'turnState', state });
        break;
      }
      case 'diagnoseResult': {
        const id = String(msg.id ?? '');
        const entry = pendingDiagnostics.get(id);
        if (entry) {
          pendingDiagnostics.delete(id);
          clearTimeout(entry.timer);
          entry.resolve((msg.report as DiagnosticReport) ?? null);
        }
        break;
      }
      default:
        break;
    }
  } catch (e) {
    if (msg && typeof msg.id === 'string') {
      const replyType = msg.t === 'manifest' ? 'manifestResult' : 'toolResult';
      send({
        t: replyType,
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ---- tab cleanup ----

chrome.tabs.onRemoved.addListener((tabId) => {
  contentPorts.delete(tabId);
  void (async () => {
    const binding = await store.getBinding(tabId);
    await Promise.all([
      store.clearBinding(tabId),
      store.clearTurnState(tabId),
      store.clearTrustedTools(tabId),
    ]);
    if (binding) {
      await maybeCloseConnection(binding.port);
    }
  })();
});

// ---- popup requests (chrome.runtime.onMessage) ----

chrome.runtime.onMessage.addListener(
  (msg: BgRequest, _sender, sendResponse: (v: unknown) => void) => {
    void (async () => {
      try {
        switch (msg.t) {
          case 'scan': {
            const daemons: HandshakeInfo[] = await scanForDaemons();
            sendResponse({ ok: true, daemons });
            break;
          }
          case 'bind': {
            await store.setBinding(msg.tabId, { port: msg.port, token: msg.token });
            try {
              const conn = await ensureConnection(msg.port, msg.token);
              if (!conn.connected) {
                await store.clearBinding(msg.tabId);
                sendResponse({ ok: false, error: 'WebSocket failed to complete handshake' });
                return;
              }
              const daemon = conn.snapshot();
              // Push live binding + tools + skills to the already-running content script!
              sendToTab(msg.tabId, {
                t: 'bindingUpdated',
                binding: { port: msg.port, token: msg.token },
                daemon,
              });
              void chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
              sendResponse({ ok: true, daemon });
            } catch (e) {
              await store.clearBinding(msg.tabId);
              sendResponse({
                ok: false,
                error: e instanceof Error ? e.message : 'pairing failed',
              });
            }
            break;
          }
          case 'reconnect': {
            const binding = await store.getBinding(msg.tabId);
            if (!binding) {
              sendResponse({ ok: false, error: 'No binding saved for this tab' });
              return;
            }
            try {
              const conn = await ensureConnection(binding.port, binding.token);
              const daemon = conn.snapshot();
              sendToTab(msg.tabId, { t: 'bindingUpdated', binding, daemon });
              sendResponse({ ok: true, daemon });
            } catch (e) {
              sendResponse({
                ok: false,
                error: e instanceof Error ? e.message : 'reconnect failed',
              });
            }
            break;
          }
          case 'unbind': {
            const binding = await store.getBinding(msg.tabId);
            await Promise.all([
              store.clearBinding(msg.tabId),
              store.clearTrustedTools(msg.tabId),
            ]);
            if (binding) {
              await maybeCloseConnection(binding.port);
            }
            sendToTab(msg.tabId, { t: 'bindingUpdated', binding: null, daemon: null });
            void chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
            sendResponse({ ok: true });
            break;
          }
          case 'getStatus': {
            const binding = await store.getBinding(msg.tabId);
            let daemon: HandshakeInfo | null = null;
            let tools: ToolInfo[] = [];
            let skills: SkillSummary[] = [];
            let connected = false;
            if (binding) {
              let conn = connections.get(binding.port) ?? null;
              // Lazily reconnect if the MV3 service worker restarted while bound.
              if (!conn || !conn.connected) {
                conn = await ensureConnection(binding.port, binding.token).catch(() => null);
              }
              daemon = conn?.info ?? null;
              tools = conn?.tools ?? [];
              skills = conn?.skills ?? [];
              connected = conn?.connected ?? false;
            }
            sendResponse({
              ok: true,
              binding,
              daemonInfo: daemon,
              tools,
              skills,
              connected,
              contentActive: contentPorts.has(msg.tabId),
            });
            break;
          }
          case 'getSettings': {
            sendResponse({ ok: true, settings: await store.getSettings() });
            break;
          }
          case 'setSettings': {
            const settings = await store.patchSettings(msg.patch);
            notifySettings(settings);
            sendResponse({ ok: true, settings });
            break;
          }
          case 'getAdapters': {
            const user = await store.getUserAdapters();
            const adapters = { ...BUNDLED_ADAPTERS, ...user };
            sendResponse({ ok: true, adapters, bundled: Object.keys(BUNDLED_ADAPTERS) });
            break;
          }
          case 'saveAdapter': {
            const res = validateAdapter(msg.def);
            if (!res.ok) {
              sendResponse({ ok: false, error: res.error });
              return;
            }
            await store.putUserAdapter(res.def.id, res.def);
            broadcastToContent({ t: 'adaptersChanged' });
            sendResponse({ ok: true });
            break;
          }
          case 'deleteAdapter':
          case 'resetAdapter': {
            await store.deleteUserAdapter(msg.id);
            broadcastToContent({ t: 'adaptersChanged' });
            sendResponse({ ok: true });
            break;
          }
          case 'attachSkill': {
            if (!sendToTab(msg.tabId, { t: 'attachSkill', name: msg.name })) {
              sendResponse({ ok: false, error: 'No content script active on this tab' });
              return;
            }
            sendResponse({ ok: true });
            break;
          }
          case 'stopAutomation': {
            const state = await store.getTurnState(msg.tabId);
            state.stopped = msg.stopped;
            if (!msg.stopped) {
              state.cooldownUntil = 0;
              state.backoffStreak = 0;
              state.cooldownReason = null;
            }
            await store.putTurnState(msg.tabId, state);
            void chrome.action.setBadgeText({
              tabId: msg.tabId,
              text: msg.stopped ? 'STOP' : '',
            });
            sendToTab(msg.tabId, { t: 'stopChanged', stopped: msg.stopped });
            sendResponse({ ok: true });
            break;
          }
          case 'injectHere': {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: msg.tabId },
                files: ['content.js'],
              });
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({
                ok: false,
                error: e instanceof Error ? e.message : 'injection failed',
              });
            }
            break;
          }
          case 'diagnoseTab': {
            const port = contentPorts.get(msg.tabId);
            if (!port) {
              sendResponse({ ok: false, error: 'Content script not active on this tab' });
              return;
            }
            const id = nextRequestId('diag');
            const report = await new Promise<DiagnosticReport | null>((resolve) => {
              const timer = setTimeout(() => {
                pendingDiagnostics.delete(id);
                resolve(null);
              }, 3000);
              pendingDiagnostics.set(id, { resolve, timer });
              if (!sendToTab(msg.tabId, { t: 'diagnose', id })) {
                clearTimeout(timer);
                pendingDiagnostics.delete(id);
                resolve(null);
              }
            });
            if (!report) {
              sendResponse({ ok: false, error: 'Diagnostics timed out' });
            } else {
              sendResponse({ ok: true, report });
            }
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unknown request' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // async sendResponse
  },
);

chrome.runtime.onInstalled.addListener(() => {
  console.info('[phantomdock] background installed');
});
