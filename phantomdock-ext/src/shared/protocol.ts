// Shared protocol definitions between the extension and the pdock daemon.
// Mirrors phantomdock-cli/src/server.rs — keep both in sync.

export const PROTOCOL_VERSION = 2;
export const PORT_MIN = 47800;
export const PORT_MAX = 47820;
export const PORT_RANGE = Array.from(
  { length: PORT_MAX - PORT_MIN + 1 },
  (_, i) => PORT_MIN + i,
);

export type ToolCategory = 'fs' | 'skill' | 'shell' | 'mcp';

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  readonly: boolean;
  description: string;
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface McpServerStatus {
  name: string;
  status: 'Starting' | 'Healthy' | 'Restarting' | 'Failed';
  tool_count: number;
}

/** GET /handshake — non-sensitive daemon metadata (never includes the token). */
export interface HandshakeInfo {
  protocol_version: number;
  server_version: string;
  port: number;
  pid: number;
  cwd: string;
  shell_enabled: boolean;
  skills_count: number;
  mcp_servers: McpServerStatus[];
}

export interface ChunkInfo {
  chunk_size_chars: number;
  total_parts: number;
}

export type ToolDelivery =
  | {
      mode: 'upload';
      filename: string;
      mime: string;
      content: string;
      chunk_info: ChunkInfo | null;
    }
  | { mode: 'inline_part'; part: number; total_parts: number; outline: string[] }
  | { mode: 'offload'; path: string; total_chars: number };

export interface ToolResultPayload {
  status: string; // ok | upload_ready | inline_part | offloaded | timeout | error
  text: string;
  delivery: ToolDelivery | null;
}

export interface ToolErrorPayload {
  code: string;
  message: string;
}

// ---- Daemon WS messages (client -> server) ----

export interface ToolCallRequest {
  id: string;
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
}

export interface ManifestRequest {
  id: string;
  type: 'manifest';
}

// ---- Daemon WS messages (server -> client) ----

export interface HelloMessage extends HandshakeInfo {
  type: 'hello';
  skills: SkillSummary[];
  tools: ToolInfo[];
}

export interface ToolResultMessage {
  id: string;
  type: 'tool_result';
  ok: boolean;
  result?: ToolResultPayload;
  error?: ToolErrorPayload;
}

export interface ManifestResultMessage {
  id: string;
  type: 'manifest_result';
  ok: boolean;
  xml: string;
  tools: ToolInfo[];
}

export interface KeepaliveMessage {
  type: 'keepalive';
  ts: number;
}

export interface ServerErrorMessage {
  id?: string;
  type: 'error';
  error: ToolErrorPayload;
}

export type ServerMessage =
  | HelloMessage
  | ToolResultMessage
  | ManifestResultMessage
  | KeepaliveMessage
  | ServerErrorMessage;

export type ClientMessage = ToolCallRequest | ManifestRequest | { type: 'keepalive_ack' };

// ---- Extension settings (persisted in chrome.storage.local, editable in popup) ----

export interface GuardSettings {
  submitDelayRangeMs: [number, number];
  interTurnDelayRangeMs: [number, number];
  sendEnableTimeoutMs: number;
  cooldownSeconds: number;
  backoffMultiplier: number;
  maxCooldownSeconds: number;
  maxConsecutiveAutoTurns: number;
  maxAutomatedTurnsPerHour: number;
  requireVisibleTab: boolean;
  autoSendAllParts: boolean;
  autoPrependFirstTurn: boolean;
  autoApproveReadOnly: boolean;
  challengeWatch: boolean;
}

export const DEFAULT_SETTINGS: GuardSettings = {
  submitDelayRangeMs: [400, 1400],
  interTurnDelayRangeMs: [3000, 8000],
  sendEnableTimeoutMs: 2500,
  cooldownSeconds: 60,
  backoffMultiplier: 2,
  maxCooldownSeconds: 900,
  maxConsecutiveAutoTurns: 15,
  maxAutomatedTurnsPerHour: 60,
  requireVisibleTab: true,
  autoSendAllParts: false,
  autoPrependFirstTurn: false,
  autoApproveReadOnly: true,
  challengeWatch: true,
};

// ---- runtime messaging (popup/content <-> background) ----

export interface TabBinding {
  port: number;
  token: string;
}

export interface DaemonSnapshot {
  info: HandshakeInfo | null;
  tools: ToolInfo[];
  skills: SkillSummary[];
  connected: boolean;
}

export interface DiagnosticReport {
  adapterId: string;
  adapterName: string;
  host: string;
  bound: boolean;
  inputFound: boolean;
  sendButtonFound: boolean;
  assistantCount: number;
  userCount: number;
  streaming: boolean;
  challengeVisible: boolean;
  rateLimitVisible: boolean;
}

export type BgRequest =
  | { t: 'scan' }
  | { t: 'bind'; tabId: number; port: number; token: string }
  | { t: 'unbind'; tabId: number }
  | { t: 'reconnect'; tabId: number }
  | { t: 'getStatus'; tabId: number }
  | { t: 'getSettings' }
  | { t: 'setSettings'; patch: Partial<GuardSettings> }
  | { t: 'getAdapters' }
  | { t: 'saveAdapter'; def: unknown }
  | { t: 'deleteAdapter'; id: string }
  | { t: 'resetAdapter'; id: string }
  | { t: 'attachSkill'; tabId: number; name: string }
  | { t: 'injectHere'; tabId: number }
  | { t: 'stopAutomation'; tabId: number; stopped: boolean }
  | { t: 'diagnoseTab'; tabId: number };

export interface BgStatusResponse {
  ok: boolean;
  binding: TabBinding | null;
  daemonInfo: HandshakeInfo | null;
  skills: SkillSummary[];
  tools: ToolInfo[];
  connected: boolean;
  contentActive: boolean;
}

export interface AdapterListResponse {
  adapters: Record<string, unknown>[]; // validated AdapterDef
  bundled: string[];
}

// ---- misc helpers ----

export function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export function randomFromRange([min, max]: [number, number]): number {
  return randomInt(min, max);
}

/** Random point inside the inner `fraction` of a rect (human-ish click coords). */
export function clickPointInRect(
  rect: { x: number; y: number; width: number; height: number },
  fraction = 0.6,
): { clientX: number; clientY: number } {
  const fx = (rect.width * (1 - fraction)) / 2;
  const fy = (rect.height * (1 - fraction)) / 2;
  return {
    clientX: randomInt(Math.round(rect.x + fx), Math.round(rect.x + rect.width - fx)),
    clientY: randomInt(Math.round(rect.y + fy), Math.round(rect.y + rect.height - fy)),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Simple id generator for correlation across port messages. */
let idCounter = 0;
export function nextRequestId(prefix = 'r'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
