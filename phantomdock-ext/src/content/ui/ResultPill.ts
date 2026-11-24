// <tool_result> user bubbles collapse into a compact expandable pill, keeping
// a non-zero bounding box on the bubble so anchorOver never collapses to (0,0).

import { anchorOver, getShadowRoot, h } from './shadow';

/** Collapse a user message element that contains tool_result XML. */
export function collapseToolResultBubble(
  userEl: HTMLElement,
  toolNames: string[],
): { pill: HTMLElement; restore: () => void; expand: (v: boolean) => void } {
  const root = getShadowRoot();

  const savedUserCss = userEl.style.cssText;
  const applyMask = (): void => {
    // Keep a 32px collapsed height with hidden overflow so userEl retains its
    // true layout coordinates and never teleports the pill to (8, 8).
    userEl.style.maxHeight = '32px';
    userEl.style.minHeight = '32px';
    userEl.style.overflow = 'hidden';
    userEl.style.opacity = '0.04';
  };
  const clearMask = (): void => {
    userEl.style.cssText = savedUserCss;
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
        'position:fixed;pointer-events:auto;padding:5px 10px;border-radius:999px;font-size:11px;cursor:pointer;display:flex;gap:6px;align-items:center;',
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
