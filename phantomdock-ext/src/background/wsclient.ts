// Daemon WebSocket client living in the extension background context.
// All localhost traffic originates here (service worker / background scripts),
// so content scripts never touch http://127.0.0.1 (no PNA / Mixed Content).

import {
  nextRequestId,
  type HandshakeInfo,
  type HelloMessage,
  type ManifestResultMessage,
  type ServerMessage,
  type SkillSummary,
  type ToolInfo,
  type ToolResultPayload,
} from '../shared/protocol';

export interface DaemonEvents {
  onHello?: (hello: HelloMessage) => void;
  onDisconnect?: (port: number) => void;
}

interface Pending {
  resolve: (v: ToolResultPayload | ManifestResultMessage) => void;
  reject: (e: Error) => void;
  kind: 'tool' | 'manifest';
  timer: number;
}

export class DaemonConnection {
  readonly port: number;
  readonly token: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private readonly events: DaemonEvents;

  // Populated from the hello message.
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
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closedByUser = false;
      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`,
        );
        this.ws = ws;

        const openTimer = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            ws.close();
            reject(new Error('connection timeout'));
          }
        }, 4000);

        ws.addEventListener('open', () => {
          clearTimeout(openTimer);
          this.reconnectAttempts = 0;
          resolve();
        });
        ws.addEventListener('message', (ev) => this.handleMessage(String(ev.data)));
        ws.addEventListener('close', () => {
          clearTimeout(openTimer);
          this.failAllPending('connection closed');
          this.ws = null;
          this.events.onDisconnect?.(this.port);
          if (!this.closedByUser) {
            this.scheduleReconnect();
          }
        });
        ws.addEventListener('error', () => {
          clearTimeout(openTimer);
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 6) return; // give up; popup/button can retry
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        /* close handler schedules the next attempt */
      });
    }, delay) as unknown as number;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
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
        this.events.onHello?.(msg);
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
      case 'keepalive':
        this.send({ type: 'keepalive_ack' });
        break;
      default:
        break;
    }
  }

  private send(v: unknown): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(v));
    }
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
      this.send({ id, type: 'tool_call', tool, args });
    });
  }

  requestManifest(timeoutMs = 10_000): Promise<ManifestResultMessage> {
    return new Promise((resolve, reject) => {
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
      this.send({ id, type: 'manifest' });
    });
  }
}
