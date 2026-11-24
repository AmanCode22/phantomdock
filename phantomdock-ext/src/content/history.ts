// History hydration: on thread reload, pdock_call blocks whose ids match a
// later <tool_result id="..."> are recorded so they never re-run, and their
// raw fenced blocks are non-destructively masked.

import type { AdapterDef } from '../adapters/schema';
import {
  extractResultIds,
  looksLikePdockCallBlock,
  parsePdockCallsFromElement,
} from './parser';

export function hydrateHistory(adapter: AdapterDef): { firedKeys: string[] } {
  const firedKeys: string[] = [];
  const resultIds = new Set<string>();

  try {
    const userEls = document.querySelectorAll<HTMLElement>(adapter.selectors.userMessage);
    for (const u of userEls) {
      for (const id of extractResultIds(u.textContent ?? '')) resultIds.add(id);
    }
  } catch {
    /* ignore invalid selector */
  }

  let assistantEls: NodeListOf<HTMLElement>;
  try {
    assistantEls = document.querySelectorAll<HTMLElement>(adapter.selectors.assistantMessage);
  } catch {
    return { firedKeys };
  }

  for (const el of assistantEls) {
    const parsed = parsePdockCallsFromElement(
      el,
      adapter.selectors.messageMarkdownBody,
      adapter.selectors.userMessage,
    );
    if (!parsed.hasCalls) continue;
    for (const call of parsed.calls) {
      firedKeys.push(callKey(call));
    }
    // Only mask historical blocks that were already executed in a previous turn.
    if (parsed.calls.some((c) => resultIds.has(c.id))) {
      maskRawCallBlocks(el);
    }
  }
  return { firedKeys };
}

/** Stable identity for cross-batch dedupe (id, name, and exact arguments). */
export function callKey(call: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): string {
  return `${call.id}::${call.name}::${stableArgs(call.args)}`;
}

function stableArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Hide raw ```pdock_call pre blocks via inline CSS (no node removal). */
export function maskRawCallBlocks(containerEl: HTMLElement): void {
  const pres = containerEl.querySelectorAll<HTMLElement>('pre');
  for (const pre of pres) {
    if (looksLikePdockCallBlock(pre)) {
      pre.style.display = 'none';
    }
  }
}
