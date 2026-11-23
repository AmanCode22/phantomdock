// History hydration: on thread reload, pdock_call blocks whose ids match a
// later <tool_result id="..."> render as collapsed Executed cards (never
// re-run); unresolved ones render as Awaiting Approval with a stale badge.

import type { AdapterDef } from '../adapters/schema';
import { extractResultIds, parsePdockCalls } from './parser';
import { ToolCard } from './ui/ToolCard';

export function hydrateHistory(adapter: AdapterDef): void {
  const resultIds = new Set<string>();
  const userEls = document.querySelectorAll<HTMLElement>(adapter.selectors.userMessage);
  for (const u of userEls) {
    for (const id of extractResultIds(u.textContent ?? '')) resultIds.add(id);
  }

  const assistantEls = document.querySelectorAll<HTMLElement>(adapter.selectors.assistantMessage);
  for (const el of assistantEls) {
    const body = el.querySelector<HTMLElement>(adapter.selectors.messageMarkdownBody) ?? el;
    const parsed = parsePdockCalls(body.textContent ?? '');
    if (!parsed.hasCalls) continue;
    for (const call of parsed.calls) {
      const card = new ToolCard(
        call,
        null,
        { onApprove: () => undefined, onReject: () => undefined, onTrustSession: () => undefined },
        el,
        !resultIds.has(call.id),
      );
      if (resultIds.has(call.id)) {
        card.setExecutedSummary(`${call.name} — resolved in a previous turn`);
      }
    }
    // Non-destructively mask the raw pdock_call fence inside this message.
    maskRawCallBlocks(body);
  }
}

/** Hide raw ```pdock_call pre blocks via inline CSS (no node removal). */
export function maskRawCallBlocks(bodyEl: HTMLElement): void {
  const pres = bodyEl.querySelectorAll<HTMLElement>('pre');
  for (const pre of pres) {
    if (looksLikePdockCall(pre.textContent ?? '')) {
      pre.style.display = 'none';
    }
  }
}

function looksLikePdockCall(text: string): boolean {
  try {
    const json = text.trim();
    if (!json.startsWith('{')) return false;
    const v = JSON.parse(json) as Record<string, unknown>;
    return typeof v.id === 'string' && typeof v.name === 'string';
  } catch {
    return false;
  }
}
