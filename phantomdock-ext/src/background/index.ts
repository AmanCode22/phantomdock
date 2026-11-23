// PhantomDock background context: the single owner of all localhost traffic.
// Routes messages between content scripts (runtime.Port), the popup
// (runtime.onMessage), and the pdock daemon (WebSocket).

import qwen from '../adapters/qwen.json';
import deepseek from '../adapters/deepseek.json';
import chatgpt from '../adapters/chatgpt.json';
import universal from '../adapters/universal.json';
import { validateAdapter } from '../adapters/schema';
import {
  type BgRequest,
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
  'universal-fallback': universal,
};

// ---- daemon connection pool (one WS per port) ----

const connections = new Map<number, DaemonConnection>();

function broadcastToContent(msg: unknown): void {
  for (const port of contentPorts.values()) {
    try {
      port.postMessage(msg);
    } catch {
      // port closed — cleaned up in onDisconnect
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
      await existing.connect().catch(() => undefined);
    }
    return existing;
  }
  existing?.close();
  const conn = new DaemonConnection(port, token, {
    onDisconnect: (p) => broadcastToContent({ t: 'daemonDisconnected', port: p }),
  });
  connections.set(port, conn);
  await conn.connect();
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

const contentPorts = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pdock-content') return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }
  contentPorts.set(tabId, port);
  port.onDisconnect.addListener(() => contentPorts.delete(tabId));
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
      /* closed */
    }
  };

  try {
    switch (msg.t) {
      case 'hello': {
        const [binding, settings, trusted] = await Promise.all([
          store.getBinding(tabId),
          store.getSettings(),
          store.getTrustedTools(tabId),
        ]);
        if (binding) {
          const conn = await ensureConnection(binding.port, binding.token).catch(() => null);
          send({
            t: 'init',
            binding,
            settings,
            trustedTools: trusted,
            daemon: conn
              ? {
                  info: conn.info,
                  tools: conn.tools,
                  skills: conn.skills,
                  connected: conn.connected,
                }
              : null,
          });
        } else {
          send({ t: 'init', binding: null, settings, trustedTools: trusted, daemon: null });
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
        if (!conn) {
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
        state.stopped = Boolean(msg.stopped);
        await store.putTurnState(tabId, state);
        void chrome.action.setBadgeText({ tabId, text: state.stopped ? 'STOP' : '' });
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
      default:
        break;
    }
  } catch (e) {
    if (msg && typeof msg.id === 'string') {
      send({
        t: 'toolResult',
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

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
            // Verify the token actually opens a WS before declaring success.
            try {
              const conn = await ensureConnection(msg.port, msg.token);
              if (!conn.connected) {
                sendResponse({ ok: false, error: 'WebSocket failed to open' });
                return;
              }
              sendResponse({
                ok: true,
                daemon: {
                  info: conn.info,
                  tools: conn.tools,
                  skills: conn.skills,
                  connected: true,
                },
              });
            } catch (e) {
              await store.clearBinding(msg.tabId);
              sendResponse({
                ok: false,
                error: e instanceof Error ? e.message : 'pairing failed',
              });
            }
            break;
          }
          case 'unbind': {
            const binding = await store.getBinding(msg.tabId);
            await store.clearBinding(msg.tabId);
            if (binding) {
              await maybeCloseConnection(binding.port);
            }
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
              const conn = connections.get(binding.port) ?? null;
              daemon = conn?.info ?? null;
              tools = conn?.tools ?? [];
              skills = conn?.skills ?? [];
              connected = conn?.connected ?? false;
            }
            sendResponse({ ok: true, binding, daemonInfo: daemon, tools, skills, connected });
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
            sendResponse({ ok: true });
            break;
          }
          case 'deleteAdapter':
          case 'resetAdapter': {
            await store.deleteUserAdapter(msg.id);
            sendResponse({ ok: true });
            break;
          }
          case 'attachSkill': {
            const p = contentPorts.get(msg.tabId);
            if (!p) {
              sendResponse({ ok: false, error: 'No content script on this tab' });
              return;
            }
            p.postMessage({ t: 'attachSkill', name: msg.name });
            sendResponse({ ok: true });
            break;
          }
          case 'stopAutomation': {
            const state = await store.getTurnState(msg.tabId);
            state.stopped = msg.stopped;
            await store.putTurnState(msg.tabId, state);
            void chrome.action.setBadgeText({
              tabId: msg.tabId,
              text: msg.stopped ? 'STOP' : '',
            });
            const p = contentPorts.get(msg.tabId);
            p?.postMessage({ t: 'stopChanged', stopped: msg.stopped });
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
