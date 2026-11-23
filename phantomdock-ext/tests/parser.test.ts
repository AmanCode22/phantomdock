import { describe, expect, it } from 'vitest';
import {
  composeTurnReply,
  extractResultIds,
  parsePdockCalls,
  renderToolResult,
} from '../src/content/parser';

describe('parsePdockCalls', () => {
  it('parses a single valid call', () => {
    const text =
      'Let me read that file.\n```pdock_call\n{"id":"call_01","name":"read_file","args":{"path":"a.txt"}}\n```\nDone.';
    const out = parsePdockCalls(text);
    expect(out.hasCalls).toBe(true);
    expect(out.calls).toEqual([{ id: 'call_01', name: 'read_file', args: { path: 'a.txt' } }]);
    expect(out.invalid).toBe(0);
  });

  it('batches multiple calls in one turn', () => {
    const text = [
      '```pdock_call',
      '{"id":"c1","name":"read_file","args":{"path":"x"}}',
      '```',
      '```pdock_call',
      '{"id":"c2","name":"list_dir","args":{}}',
      '```',
    ].join('\n');
    const out = parsePdockCalls(text);
    expect(out.calls.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('skips invalid JSON but keeps valid siblings', () => {
    const text = [
      '```pdock_call',
      '{"id":"c1","name":"read_file","args":{"path":"x"}}',
      '```',
      '```pdock_call',
      'this is { not json',
      '```',
    ].join('\n');
    const out = parsePdockCalls(text);
    expect(out.calls.length).toBe(1);
    expect(out.invalid).toBe(1);
  });

  it('rejects payloads with non-object args or missing name', () => {
    const text = [
      '```pdock_call',
      '{"id":"c1","name":"read_file","args":[1,2]}',
      '```',
      '```pdock_call',
      '{"id":"c2","args":{}}',
      '```',
    ].join('\n');
    const out = parsePdockCalls(text);
    expect(out.calls.length).toBe(0);
    expect(out.invalid).toBe(2);
  });

  it('tolerates trailing prose after the last fence', () => {
    const text =
      '```pdock_call\n{"id":"c1","name":"list_dir","args":{}}\n```\nI will now wait for results before continuing.';
    const out = parsePdockCalls(text);
    expect(out.calls.length).toBe(1);
    expect(out.invalid).toBe(0);
  });

  it('parses an unclosed fence at end of stream', () => {
    const text = '```pdock_call\n{"id":"c9","name":"read_file","args":{"path":"z"}}';
    const out = parsePdockCalls(text);
    expect(out.calls.length).toBe(1);
    expect(out.calls[0].id).toBe('c9');
  });

  it('returns empty for plain prose', () => {
    const out = parsePdockCalls('Just a normal answer with ```js\nconsole.log(1)\n``` inside.');
    expect(out.hasCalls).toBe(false);
    expect(out.calls.length).toBe(0);
  });

  it('does not double-count an unclosed match over a closed fence', () => {
    const text = '```pdock_call\n{"id":"c1","name":"list_dir","args":{}}\n```';
    const out = parsePdockCalls(text);
    expect(out.calls.length).toBe(1);
  });
});

describe('renderToolResult / composeTurnReply', () => {
  it('renders rejection envelopes', () => {
    const xml = renderToolResult({
      call: { id: 'c1', name: 'write_file', args: {} },
      approved: false,
      result: null,
    });
    expect(xml).toContain('status="rejected"');
    expect(xml).toContain('id="c1"');
  });

  it('renders uploaded skill envelopes with attached_file', () => {
    const xml = renderToolResult({
      call: { id: 'c1', name: 'activate_skill', args: { name: 'grill-me' } },
      approved: true,
      result: {
        status: 'upload_ready',
        text: 'attached',
        delivery: {
          mode: 'upload',
          filename: 'grill-me-skill.md',
          mime: 'text/markdown',
          content: '# x',
          chunk_info: null,
        },
      },
    });
    expect(xml).toContain('status="uploaded"');
    expect(xml).toContain('attached_file="grill-me-skill.md"');
  });

  it('renders inline part envelopes with outline and part attributes', () => {
    const xml = renderToolResult({
      call: { id: 'c2', name: 'activate_skill', args: { name: 'grill-me', part: 1 } },
      approved: true,
      result: {
        status: 'inline_part',
        text: 'Part 1 content',
        delivery: { mode: 'inline_part', part: 1, total_parts: 3, outline: ['Rules'] },
      },
    });
    expect(xml).toContain('status="inline_part"');
    expect(xml).toContain('part="1"');
    expect(xml).toContain('total_parts="3"');
    expect(xml).toContain('Part 1 content');
    expect(xml).toContain('"part":2');
  });

  it('escapes XML-significant characters in tool text', () => {
    const xml = renderToolResult({
      call: { id: 'c3', name: 'read_file', args: {} },
      approved: true,
      result: { status: 'ok', text: 'if (a < b && b > c) { x = "&"', delivery: null },
    });
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('a < b');
  });

  it('composes one combined reply for the whole batch', () => {
    const reply = composeTurnReply([
      {
        call: { id: 'a', name: 'read_file', args: {} },
        approved: true,
        result: { status: 'ok', text: 'content-a', delivery: null },
      },
      {
        call: { id: 'b', name: 'list_dir', args: {} },
        approved: false,
        result: null,
      },
    ]);
    expect(reply).toContain('<tool_results count="2">');
    expect(reply.match(/<tool_result /g)?.length).toBe(2);
    expect(reply.trim().endsWith('</tool_results>')).toBe(true);
  });

  it('extracts result ids for history hydration', () => {
    const ids = extractResultIds(
      '<tool_result id="call_01" name="read_file" status="ok">x</tool_result>\n<tool_result id="call_02" name="list_dir" status="ok">y</tool_result>',
    );
    expect(ids).toEqual(['call_01', 'call_02']);
  });
});
