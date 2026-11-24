import { describe, expect, it } from 'vitest';
import { validateAdapter } from '../src/adapters/schema';
import qwen from '../src/adapters/qwen.json';
import deepseek from '../src/adapters/deepseek.json';
import chatgpt from '../src/adapters/chatgpt.json';
import universal from '../src/adapters/universal.json';

describe('bundled adapter presets', () => {
  it.each([
    ['qwen-chat', qwen],
    ['deepseek-chat', deepseek],
    ['chatgpt', chatgpt],
    ['universal-fallback', universal],
  ])('validates %s against schema v2', (_label, def) => {
    const res = validateAdapter(def);
    expect(res.ok).toBe(true);
  });

  it('preset ids match the spec bundle list', () => {
    expect(qwen.id).toBe('qwen-chat');
    expect(deepseek.id).toBe('deepseek-chat');
    expect(chatgpt.id).toBe('chatgpt');
    expect(universal.id).toBe('universal-fallback');
  });

  it('universal fallback matches any host', () => {
    expect(universal.hostMatch).toContain('*');
  });

  it('deepseek userMessage does not match bare .ds-message (which includes assistant turns)', () => {
    const parts = deepseek.selectors.userMessage.split(',').map((s) => s.trim());
    expect(parts).not.toContain('.ds-message');
  });

  it('qwen streamingIndicator does not match the idle send button', () => {
    expect(qwen.selectors.streamingIndicator).not.toContain('button.send-button:not(.disabled)');
  });
});

describe('validateAdapter rejects malformed input', () => {
  it('rejects a bad id, missing selectors, and inverted ranges', () => {
    const broken = { ...qwen, id: 'Not A Valid ID' };
    expect(validateAdapter(broken).ok).toBe(false);

    const noSelectors = { ...qwen };
    delete (noSelectors as Record<string, unknown>).selectors;
    expect(validateAdapter(noSelectors).ok).toBe(false);

    const inverted = JSON.parse(JSON.stringify(qwen));
    inverted.inputBehavior.submitDelayRangeMs = [1400, 400];
    expect(validateAdapter(inverted).ok).toBe(false);
  });

  it('reports a readable error message', () => {
    const broken = JSON.parse(JSON.stringify(qwen));
    broken.loopProtection.maxConsecutiveAutoTurns = 0;
    const res = validateAdapter(broken);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('loopProtection');
    }
  });
});
