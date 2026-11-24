// Daemon WebSocket client living in the extension background context.
// All localhost traffic originates here (service worker / background scripts),
// so content scripts never touch http://127.0.0.1 (no PNA / Mixed Content).
//
// Key reliability guarantees:
// - connect() waits for the server's `hello` handshake before resolving, so
//   `info`, `tools`, and `skills` are populated immediately on pair/init.
// - Concurrent connect() calls share a single in-flight promise.
// - Auth failures (close before hello on first connect) reject cleanly without
//   spinning reconnect loops.
// - Keepalive messages are acknowledged to keep MV3 service workers alive.

import {
  nextRequestId,
  type DaemonSnapshot,
  type HandshakeInfo,
  type HelloMessage,
  type ManifestResultMessage,
  type ServerMessage,
  type SkillSummary,
  type ToolInfo,
  type ToolResultPayload,
} from '../shared/protocol';

export interface DaemonEvents {
  onHello?: (port: number, hello: HelloMessage) => void;
  onDisconnect?: (port: number) => void;
}

interface Pending {
  resolve: (v: ToolResultPayload | ManifestResultMessage) => void;
  reject: (e: Error) => void;
  kind: 'tool' | 'manifest';
  timer: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 8;

export class DaemonConnection {
  readonly port: number;
  readonly token: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  private hasEverConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectInFlight: Promise<void> | null = null;
  private helloWaiter: {
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;
  private readonly events: DaemonEvents;

  // Populated from the server's `hello` message.
  hello: HelloMessage | null = null;
  info: HandshakeInfo | null = null;
  tools: ToolInfo[] = [];
  skills: SkillSummary[] = [];

  constructor(port: number, token: string, events: DaemonEvents = {}) {
    this.port = port;
    this.token = token;
    this.events = events;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.hello !== null;
  }

  snapshot(): DaemonSnapshot {
    return {
      info: this.info,
      tools: this.tools,
      skills: this.skills,
      connected: this.connected,
    };
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectInFlight) return this.connectInFlight;

    this.closedByUser = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        this.helloWaiter = null;
        this.connectInFlight = null;
        this.hasEverConnected = true;
        this.reconnectAttempts = 0;
        resolve();
      };
      const finishErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        this.helloWaiter = null;
        this.connectInFlight = null;
        reject(err);
      };

      const openTimer = setTimeout(() => {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        finishErr(new Error(`Daemon on port ${this.port} timed out during handshake`));
      }, CONNECT_TIMEOUT_MS);

      this.helloWaiter = { resolve: finishOk, reject: finishErr };

      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`,
        );
        this.ws = ws;

        ws.addEventListener('message', (ev) => {
          this.handleMessage(String(ev.data));
        });

        ws.addEventListener('close', (ev) => {
          const wasOpen = this.hello !== null;
          this.failAllPending('Daemon connection closed');
          if (this.ws === ws) {
            this.ws = null;
          }
          if (!settled) {
            const reason = ev.reason
              ? ev.reason
              : wasOpen
                ? 'Connection closed before handshake completed'
                : 'Connection rejected (check pairing token and that pdock is running)';
            finishErr(new Error(reason));
          }
          this.events.onDisconnect?.(this.port);
          // Only auto-reconnect if we previously succeeded (don't hammer bad tokens).
          if (!this.closedByUser && this.hasEverConnected) {
            this.scheduleReconnect();
          }
        });

        ws.addEventListener('error', () => {
          // The close event always follows error and handles rejection/cleanup.
        });
      } catch (e) {
        finishErr(e instanceof Error ? e : new Error(String(e)));
      }
    });

    this.connectInFlight = promise;
    return promise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closedByUser) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.connect().catch(() => {
        /* close handler schedules next attempt if needed */
      });
    }, delay);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.helloWaiter?.reject(new Error('closed'));
    this.helloWaiter = null;
    this.connectInFlight = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.failAllPending('closed');
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.hello = msg;
        this.info = msg;
        this.tools = msg.tools ?? [];
        this.skills = msg.skills ?? [];
        this.helloWaiter?.resolve();
        this.events.onHello?.(this.port, msg);
        break;
      case 'tool_result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok && msg.result) {
            p.resolve(msg.result);
          } else {
            p.reject(
              new Error(
                msg.error ? `${msg.error.code}: ${msg.error.message}` : 'tool failed',
              ),
            );
          }
        }
        break;
      }
      case 'manifest_result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) {
            p.resolve(msg);
          } else {
            p.reject(new Error('manifest request failed'));
          }
        }
        break;
      }
      case 'error': {
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          }
        }
        break;
      }
      case 'keepalive':
        this.send({ type: 'keepalive_ack' });
        break;
      default:
        break;
    }
  }

  private send(v: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(v));
      return true;
    }
    return false;
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  requestToolCall(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 180_000,
  ): Promise<ToolResultPayload> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Daemon is not connected'));
        return;
      }
      const id = nextRequestId('call');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tool call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as Pending['resolve'],
        reject,
        kind: 'tool',
        timer,
      });
      if (!this.send({ id, type: 'tool_call', tool, args })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Failed to send tool call over WebSocket'));
      }
    });
  }

  requestManifest(timeoutMs = 10_000): Promise<ManifestResultMessage> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Daemon is not connected'));
        return;
      }
      const id = nextRequestId('man');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('manifest request timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as Pending['resolve'],
        reject,
        kind: 'manifest',
        timer,
      });
      if (!this.send({ id, type: 'manifest' })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Failed to send manifest request over WebSocket'));
      }
    });
  }
}
