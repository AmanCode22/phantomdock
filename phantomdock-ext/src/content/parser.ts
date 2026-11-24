// Post-stream ```pdock_call fenced-block parser + multi-call turn batching.
// Pure functions — unit tested. Tolerates trailing prose, unclosed fences at
// end-of-stream, rendered code blocks without ``` fences, and minor LLM
// formatting variations (e.g. missing args on zero-arg tools or `arguments`).

import type { ToolResultPayload } from '../shared/protocol';

export interface ParsedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ParseOutcome {
  calls: ParsedCall[];
  invalid: number;
  hasCalls: boolean;
}

const FENCE_CLOSED = /```pdock_call[ \t]*\r?\n([\s\S]*?)```/g;
const FENCE_UNCLOSED = /```pdock_call[ \t]*\r?\n([\s\S]*)$/;

// The manifest's syntax example uses TOOL_NAME as a placeholder; never treat a
// quoted example as a real call.
const PLACEHOLDER_NAMES = new Set(['TOOL_NAME', 'tool_name']);

// Thinking / chain-of-thought containers whose draft code blocks must NOT fire.
const THINKING_CONTAINER_SELECTOR =
  ".ds-think-content, [class*='think-content'], [class*='thought-content'], [class*='reasoning-content'], details:not([open])";

/** Parse all pdock_call blocks from an assistant message's markdown text. */
export function parsePdockCalls(text: string): ParseOutcome {
  const calls: ParsedCall[] = [];
  let invalid = 0;

  const consume = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) {
      invalid++;
      return;
    }
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (isStrictParsedCall(v) && !PLACEHOLDER_NAMES.has(v.name)) {
        calls.push(v);
      } else {
        invalid++;
      }
    } catch {
      invalid++;
    }
  };

  const closed = [...text.matchAll(FENCE_CLOSED)];
  for (const m of closed) {
    consume(m[1]);
  }
  // Trailing unclosed fence (model stopped early / streaming cut off): only
  // consider text after the last closed fence.
  const lastEnd = closed.length
    ? closed[closed.length - 1].index! + closed[closed.length - 1][0].length
    : 0;
  const rest = text.slice(lastEnd);
  const unclosed = rest.match(FENCE_UNCLOSED);
  if (unclosed && unclosed[1].trim()) {
    consume(unclosed[1]);
  }

  return { calls, invalid, hasCalls: calls.length > 0 || invalid > 0 };
}

function isStrictParsedCall(v: unknown): v is ParsedCall {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    c.id.length > 0 &&
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    typeof c.args === 'object' &&
    c.args !== null &&
    !Array.isArray(c.args)
  );
}

/**
 * Tolerant normalizer used on rendered DOM code blocks:
 * - accepts `name` or (when labeled pdock_call) `tool`
 * - accepts `args` or `arguments` (defaults to `{}` if omitted)
 * - synthesizes a stable `id` if omitted on a clearly labeled `pdock_call` block
 */
function normalizeDomCall(
  v: unknown,
  explicitlyLabeled: boolean,
  fallbackIndex: number,
): ParsedCall | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const name =
    typeof c.name === 'string' && c.name.trim()
      ? c.name.trim()
      : explicitlyLabeled && typeof c.tool === 'string' && c.tool.trim()
        ? c.tool.trim()
        : null;
  if (!name || PLACEHOLDER_NAMES.has(name)) return null;

  let id: string | null =
    typeof c.id === 'string' && c.id.trim() ? c.id.trim() : null;
  if (!id) {
    if (!explicitlyLabeled) return null;
    id = `auto_${fallbackIndex}_${name}`;
  }

  let rawArgs: unknown = c.args !== undefined ? c.args : c.arguments;
  if (rawArgs === undefined || rawArgs === null) {
    rawArgs = {};
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;

  return { id, name, args: rawArgs as Record<string, unknown> };
}

/**
 * Extract balanced top-level JSON objects from a string (quote- and
 * escape-aware brace matching). Rendered code blocks lose their ``` fences and
 * pick up UI junk ("pdock_callCopyDownload{...}"), so the raw fence regex
 * never matches — this recovers the JSON from whatever surrounds it.
 */
export function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function isLabeledPdockCall(block: Element, text: string): boolean {
  if (/pdock_call/i.test(text)) return true;
  if (/pdock_call/i.test(block.className || '')) return true;
  const codeChild = block.querySelector('code');
  if (codeChild && /pdock_call/i.test(codeChild.className || '')) return true;
  const headerText = block.parentElement?.textContent?.slice(0, 120) ?? '';
  return /pdock_call/i.test(headerText);
}

/** Quick check used by history masking to detect a rendered pdock_call <pre>. */
export function looksLikePdockCallBlock(block: Element): boolean {
  const text = block.textContent ?? '';
  const labeled = isLabeledPdockCall(block, text);
  for (const obj of balancedObjects(text)) {
    try {
      const v = JSON.parse(obj) as unknown;
      if (normalizeDomCall(v, labeled, 0)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function isInsideThinking(el: Element): boolean {
  try {
    return Boolean(el.closest(THINKING_CONTAINER_SELECTOR));
  } catch {
    return false;
  }
}

/**
 * DOM-aware parsing for a rendered assistant message. Scans rendered
 * pre/code blocks (which no longer contain ``` fences), skips thinking blocks
 * and user-echoed blocks, brace-matches JSON payloads, and falls back to the
 * raw-text fence regex for plain-text renderers.
 */
export function parsePdockCallsFromElement(
  el: HTMLElement,
  markdownSelector: string,
  userMessageSelector?: string,
): ParseOutcome {
  let bodies: HTMLElement[] = [];
  try {
    bodies = [...el.querySelectorAll<HTMLElement>(markdownSelector)].filter(
      (b) => !isInsideThinking(b),
    );
  } catch {
    bodies = [];
  }
  const scanTargets: HTMLElement[] = bodies.length ? bodies : [el];
  const calls: ParsedCall[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  const scannedBlocks = new Set<Element>();

  const push = (raw: string, labeled: boolean): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    try {
      const v = JSON.parse(trimmed) as unknown;
      const normalized = normalizeDomCall(v, labeled, calls.length + 1);
      if (normalized) {
        const key = `${normalized.id}::${normalized.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push(normalized);
        }
        return true;
      }
    } catch {
      /* not JSON */
    }
    return false;
  };

  for (const body of scanTargets) {
    // 1) Rendered code blocks: prefer <pre>, plus standalone <code> not inside <pre>.
    const pres = [...body.querySelectorAll('pre')];
    const standaloneCodes = [...body.querySelectorAll('code')].filter(
      (c) => !c.closest('pre'),
    );
    const blocks: Element[] = [...pres, ...standaloneCodes];

    for (const block of blocks) {
      if (scannedBlocks.has(block)) continue;
      scannedBlocks.add(block);
      if (isInsideThinking(block)) continue;

      if (userMessageSelector) {
        try {
          if (block.closest(userMessageSelector)) continue;
        } catch {
          /* invalid selector — ignore */
        }
      }

      const text = block.textContent ?? '';
      const labeled = isLabeledPdockCall(block, text);
      const looksLikeToolJson =
        text.includes('{') && text.includes('"name"') && text.includes('"id"');
      if (!labeled && !looksLikeToolJson) continue;

      let found = false;
      for (const obj of balancedObjects(text)) {
        if (push(obj, labeled)) found = true;
      }
      if (!found && labeled) {
        invalid++;
      }
    }

    // 2) Raw-text fences (plain-text renderers that still emit literal ```).
    if (calls.length === 0) {
      const fromText = parsePdockCalls(body.textContent ?? '');
      for (const c of fromText.calls) {
        const key = `${c.id}::${c.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          calls.push(c);
        }
      }
    }
  }

  return { calls, invalid, hasCalls: calls.length > 0 || invalid > 0 };
}

// ---------------------------------------------------------------------------
// Turn batching: one combined user reply containing all <tool_result> blocks.
// ---------------------------------------------------------------------------

export interface ResolvedCall {
  call: ParsedCall;
  approved: boolean;
  result: ToolResultPayload | null; // null when rejected
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a single resolved call as a <tool_result> envelope. */
export function renderToolResult(r: ResolvedCall): string {
  const { call } = r;
  if (!r.approved) {
    return `<tool_result id="${escapeXml(call.id)}" name="${escapeXml(
      call.name,
    )}" status="rejected">The user rejected this tool call. Ask how to proceed, or continue without it.</tool_result>`;
  }
  const res = r.result;
  if (!res) {
    return `<tool_result id="${escapeXml(call.id)}" name="${escapeXml(
      call.name,
    )}" status="error">No result.</tool_result>`;
  }

  if (res.status === 'upload_ready' && res.delivery?.mode === 'upload') {
    return `<tool_result id="${escapeXml(call.id)}" name="${escapeXml(
      call.name,
    )}" status="uploaded" attached_file="${escapeXml(
      res.delivery.filename,
    )}">Skill file ${escapeXml(res.delivery.filename)} is attached to this message. Follow it strictly.</tool_result>`;
  }

  if (res.status === 'inline_part' && res.delivery?.mode === 'inline_part') {
    const d = res.delivery;
    const outline = d.outline.length
      ? `Outline:\n${d.outline.map((s, i) => `- ${i + 1}. ${s}`).join('\n')}\n`
      : '';
    const next =
      d.part < d.total_parts
        ? `Call \`activate_skill\` with {"part":${d.part + 1}} for the next part.\n\n`
        : '';
    return `<tool_result id="${escapeXml(call.id)}" name="${escapeXml(
      call.name,
    )}" status="inline_part" part="${d.part}" total_parts="${d.total_parts}">\n${outline}${next}${escapeXml(
      res.text,
    )}\n</tool_result>`;
  }

  return `<tool_result id="${escapeXml(call.id)}" name="${escapeXml(
    call.name,
  )}" status="${escapeXml(res.status)}">\n${escapeXml(res.text)}\n</tool_result>`;
}

/** Compose the single combined user reply for a fully-resolved turn. */
export function composeTurnReply(resolved: ResolvedCall[]): string {
  const parts = resolved.map(renderToolResult);
  const header = resolved.length > 1 ? `<tool_results count="${resolved.length}">\n` : '';
  const footer = resolved.length > 1 ? '\n</tool_results>' : '';
  return `${header}${parts.join('\n')}${footer}`;
}

/** Extract tool_result ids from a user message (used by history hydration). */
export function extractResultIds(userText: string): string[] {
  const re = /<tool_result\s+[^>]*\bid="([^"]+)"/g;
  return [...userText.matchAll(re)].map((m) => m[1]);
}

/** Extract tool_result names from a user message (used by ResultPill labels). */
export function extractResultNames(userText: string): string[] {
  const re = /<tool_result\s+[^>]*\bname="([^"]+)"/g;
  return [...userText.matchAll(re)].map((m) => m[1]);
}
