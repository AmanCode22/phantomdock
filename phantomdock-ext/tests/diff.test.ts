import { describe, expect, it } from 'vitest';
import { collapseContext, diffLines, diffStats } from '../src/shared/diff';

describe('diffLines', () => {
  it('detects added and removed lines', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
    const stats = diffStats(d);
    expect(stats.added).toBe(2); // x and d
    expect(stats.removed).toBe(1); // b
    expect(d.some((l) => l.kind === 'ctx' && l.text === 'a')).toBe(true);
  });

  it('returns all context for identical text', () => {
    const d = diffLines('one\ntwo', 'one\ntwo');
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
    expect(d.every((l) => l.kind === 'ctx')).toBe(true);
  });

  it('handles empty old or new text', () => {
    expect(diffStats(diffLines('', 'a\nb'))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines('a\nb', ''))).toEqual({ added: 0, removed: 2 });
  });

  it('collapses long context runs around changes', () => {
    const old = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const next = old.replace('line 25', 'line 25 CHANGED');
    const d = collapseContext(diffLines(old, next), 3);
    expect(d.length).toBeLessThan(50);
    expect(d.some((l) => l.text === '⋯')).toBe(true);
    expect(d.some((l) => l.kind === 'del' && l.text === 'line 25')).toBe(true);
    expect(d.some((l) => l.kind === 'add' && l.text === 'line 25 CHANGED')).toBe(true);
  });

  it('short-circuits oversized inputs', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `x${i}`).join('\n');
    const d = diffLines(big, big + '\nextra');
    expect(d.length).toBe(3);
    expect(d[0].text).toContain('diff too large');
  });
});
