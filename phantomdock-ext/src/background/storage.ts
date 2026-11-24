// chrome.storage wrappers: session-scoped bindings/turn-state/trusted-tools,
// persistent settings and user adapter overrides in chrome.storage.local.

import {
  DEFAULT_SETTINGS,
  type GuardSettings,
  type TabBinding,
} from '../shared/protocol';
import { initialGuardState, type GuardRuntimeState } from '../content/guards';

const KEYS = {
  bindings: 'pd_bindings_v1', // session: { [tabId]: TabBinding }
  settings: 'pd_settings_v1', // local: GuardSettings (persists across restarts)
  turnState: 'pd_turnstate_v1', // session: { [tabId]: GuardRuntimeState }
  trustedTools: 'pd_trusted_v1', // session: { [tabId]: string[] }
  adapters: 'pd_adapters_v1', // local: { [id]: AdapterDef }
} as const;

type MapOf<T> = Record<string, T>;

function sessionArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

async function getFrom<T>(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<T | null> {
  const bag = await area.get(key);
  return (bag[key] as T | undefined) ?? null;
}

async function putTo<T>(
  area: chrome.storage.StorageArea,
  key: string,
  value: T,
): Promise<void> {
  await area.set({ [key]: value });
}

// ---- bindings (session) ----

export async function getBindings(): Promise<MapOf<TabBinding>> {
  return (await getFrom<MapOf<TabBinding>>(sessionArea(), KEYS.bindings)) ?? {};
}

export async function getBinding(tabId: number): Promise<TabBinding | null> {
  const all = await getBindings();
  return all[String(tabId)] ?? null;
}

export async function setBinding(tabId: number, binding: TabBinding): Promise<void> {
  const all = await getBindings();
  all[String(tabId)] = binding;
  await putTo(sessionArea(), KEYS.bindings, all);
}

export async function clearBinding(tabId: number): Promise<void> {
  const all = await getBindings();
  delete all[String(tabId)];
  await putTo(sessionArea(), KEYS.bindings, all);
}

// ---- settings (local, persistent across browser restarts) ----

export async function getSettings(): Promise<GuardSettings> {
  const stored = await getFrom<Partial<GuardSettings>>(chrome.storage.local, KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function patchSettings(patch: Partial<GuardSettings>): Promise<GuardSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await putTo(chrome.storage.local, KEYS.settings, next);
  return next;
}

// ---- per-tab turn state (session, survives page reloads) ----

export async function getTurnState(tabId: number): Promise<GuardRuntimeState> {
  const all = (await getFrom<MapOf<GuardRuntimeState>>(sessionArea(), KEYS.turnState)) ?? {};
  return all[String(tabId)] ?? initialGuardState();
}

export async function putTurnState(tabId: number, state: GuardRuntimeState): Promise<void> {
  const all = (await getFrom<MapOf<GuardRuntimeState>>(sessionArea(), KEYS.turnState)) ?? {};
  all[String(tabId)] = state;
  await putTo(sessionArea(), KEYS.turnState, all);
}

export async function clearTurnState(tabId: number): Promise<void> {
  const all = (await getFrom<MapOf<GuardRuntimeState>>(sessionArea(), KEYS.turnState)) ?? {};
  delete all[String(tabId)];
  await putTo(sessionArea(), KEYS.turnState, all);
}

// ---- per-tab session-trusted tools ----

export async function getTrustedTools(tabId: number): Promise<string[]> {
  const all = (await getFrom<MapOf<string[]>>(sessionArea(), KEYS.trustedTools)) ?? {};
  return all[String(tabId)] ?? [];
}

export async function addTrustedTool(tabId: number, tool: string): Promise<void> {
  const all = (await getFrom<MapOf<string[]>>(sessionArea(), KEYS.trustedTools)) ?? {};
  const list = all[String(tabId)] ?? [];
  if (!list.includes(tool)) {
    list.push(tool);
  }
  all[String(tabId)] = list;
  await putTo(sessionArea(), KEYS.trustedTools, all);
}

export async function clearTrustedTools(tabId: number): Promise<void> {
  const all = (await getFrom<MapOf<string[]>>(sessionArea(), KEYS.trustedTools)) ?? {};
  delete all[String(tabId)];
  await putTo(sessionArea(), KEYS.trustedTools, all);
}

// ---- user adapter overrides (local, persistent) ----

export async function getUserAdapters(): Promise<MapOf<unknown>> {
  return (await getFrom<MapOf<unknown>>(chrome.storage.local, KEYS.adapters)) ?? {};
}

export async function putUserAdapter(id: string, def: unknown): Promise<void> {
  const all = await getUserAdapters();
  all[id] = def;
  await putTo(chrome.storage.local, KEYS.adapters, all);
}

export async function deleteUserAdapter(id: string): Promise<void> {
  const all = await getUserAdapters();
  delete all[id];
  await putTo(chrome.storage.local, KEYS.adapters, all);
}
