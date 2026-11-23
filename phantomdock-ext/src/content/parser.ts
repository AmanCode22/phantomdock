// Post-stream ```pdock_call fenced-block parser + multi-call turn batching.
// Pure functions — unit tested. Tolerates trailing prose and an unclosed fence
// at end-of-stream (edge case from the deferred live-verification list).

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
      if (isParsedCall(v)) {
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

function isParsedCall(v: unknown): v is ParsedCall {
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
