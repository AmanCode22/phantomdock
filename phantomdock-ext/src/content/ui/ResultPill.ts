// <tool_result> user bubbles collapse into a compact expandable pill, keeping
// native file attachment chips visible.

import { anchorOver, getShadowRoot, h } from './shadow';

/** Collapse a user message element that contains tool_result XML. */
export function collapseToolResultBubble(
  userEl: HTMLElement,
  toolNames: string[],
): { pill: HTMLElement; restore: () => void; expand: (v: boolean) => void } {
  const root = getShadowRoot();

  // Non-destructive CSS masking of the raw XML (no React node surgery).
  const maskTargets = Array.from(userEl.querySelectorAll<HTMLElement>('p, div, span')).filter(
    (el) => el.textContent?.includes('<tool_result'),
  );
  const targets = maskTargets.length ? maskTargets : [userEl];
  const savedStyles = targets.map((el) => el.style.cssText);
  const applyMask = (): void => {
    for (const el of targets) {
      el.style.display = 'none';
    }
  };
  const clearMask = (): void => {
    targets.forEach((el, i) => {
      el.style.cssText = savedStyles[i];
    });
  };
  applyMask();

  const label =
    toolNames.length > 0
      ? `Tool Results (${toolNames.length}): ${toolNames.slice(0, 3).join(', ')}${
          toolNames.length > 3 ? '…' : ''
        }`
      : 'Tool Results — click to inspect';
  const pill = h(
    'button',
    {
      class: 'panel',
      style:
        'position:absolute;pointer-events:auto;padding:5px 10px;border-radius:999px;font-size:11px;cursor:pointer;display:flex;gap:6px;align-items:center;',
    },
    [h('span', { text: '⇪' }), h('span', { text: label })],
  );
  root.stage.appendChild(pill);
  const cleanupAnchor = anchorOver(pill, userEl, 'cover');

  let expanded = false;
  const expand = (v: boolean): void => {
    expanded = v;
    if (expanded) clearMask();
    else applyMask();
  };
  pill.addEventListener('click', () => expand(!expanded));

  return {
    pill,
    expand,
    restore: () => {
      clearMask();
      cleanupAnchor();
      pill.remove();
    },
  };
}
