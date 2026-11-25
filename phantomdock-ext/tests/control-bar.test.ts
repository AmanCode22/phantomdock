// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import { ControlBar } from '../src/content/ui/ControlBar';
import { getShadowRoot } from '../src/content/ui/shadow';

it('filters chat skills, restores focus on Escape and attaches the chosen skill', () => {
  const attach = vi.fn();
  const bar = new ControlBar(
    { onAttachSkill: attach, onAttachWorkspace: vi.fn(), onStopToggle: vi.fn() },
    [{ name: 'docs', description: 'Write documentation' }, { name: 'ui', description: 'Design screens' }],
    true,
  );
  try {
    const { root } = getShadowRoot();
    const toggle = root.querySelector<HTMLButtonElement>('[aria-controls="pdock-skill-picker"]')!;
    const search = root.querySelector<HTMLInputElement>('.skill-search')!;
    toggle.click();
    expect(root.activeElement).toBe(search);

    search.value = 'documentation';
    search.dispatchEvent(new Event('input'));
    expect(root.querySelectorAll('.skill-results button')).toHaveLength(1);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.activeElement).toBe(toggle);

    toggle.click();
    const option = root.querySelector<HTMLButtonElement>('.skill-results button')!;
    option.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(attach).toHaveBeenCalledWith('docs');
  } finally {
    bar.remove();
  }
});
