// Native, React/ProseMirror-safe text insertion + human-paced submission.
// Zero prototype tampering: native property descriptors, dispatched events
// with bubbles, and randomized click coordinates inside the send button.

import {
  clickPointInRect,
  randomFromRange,
  sleep,
  type GuardSettings,
} from '../shared/protocol';
import type { AdapterDef } from '../adapters/schema';

export type InputEl = HTMLTextAreaElement | HTMLElement;

export function findInput(adapter: AdapterDef): InputEl | null {
  return document.querySelector<InputEl>(adapter.selectors.inputBox);
}

export function findSendButton(adapter: AdapterDef): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(adapter.selectors.sendButton);
}

export function isTextarea(el: InputEl): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

/**
 * Insert text using native setters + dispatched input events.
 * - textarea: native value descriptor + InputEvent('input') + change
 * - contenteditable: beforeinput insertFromPaste + ClipboardEvent paste +
 *   execCommand('insertText') fallback
 */
export function insertText(el: InputEl, payload: string, clearBeforeInsert: boolean): boolean {
  try {
    el.focus();
    if (isTextarea(el)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (clearBeforeInsert) {
        setter?.call(el, '');
      }
      setter?.call(el, payload);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // contenteditable (ProseMirror / Lexical / draft-ish)
    if (clearBeforeInsert) {
      const sel = window.getSelection();
      if (sel && el.contains(sel.anchorNode)) {
        sel.selectAllChildren(el);
      } else {
        el.focus();
        window.getSelection()?.selectAllChildren(el);
      }
      document.execCommand('delete');
    }
    const beforeOk = el.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertFromPaste',
        data: payload,
        bubbles: true,
        cancelable: true,
      }),
    );
    if (!beforeOk) {
      // The editor consumed beforeinput itself.
      return el.textContent === payload || el.textContent?.includes(payload.slice(0, 40)) === true;
    }
    const dt = new DataTransfer();
    dt.setData('text/plain', payload);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    if (!el.textContent?.includes(payload.slice(0, 40))) {
      document.execCommand('insertText', false, payload);
    }
    return true;
  } catch {
    return false;
  }
}

/** Wait until the send button is enabled (rAF loop with timeout). */
export async function waitForSendEnabled(
  adapter: AdapterDef,
  settings: GuardSettings,
): Promise<HTMLButtonElement | null> {
  const deadline = Date.now() + settings.sendEnableTimeoutMs;
  return new Promise((resolve) => {
    const check = (): void => {
      const btn = findSendButton(adapter);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        resolve(btn);
        return;
      }
      if (Date.now() > deadline) {
        resolve(btn);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

/** Dispatch a full pointer sequence at randomized coordinates inside the button. */
export function clickButton(btn: HTMLElement, randomize: boolean): void {
  const rect = btn.getBoundingClientRect();
  const point = randomize
    ? clickPointInRect(rect, 0.6)
    : { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: point.clientX,
    clientY: point.clientY,
    button: 0,
    buttons: 1,
  };
  btn.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 0 }));
  btn.dispatchEvent(new PointerEvent('pointerdown', opts));
  btn.dispatchEvent(new MouseEvent('mousedown', opts));
  btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  btn.dispatchEvent(new MouseEvent('click', opts));
}

/** Press Enter like a keyboard user. */
export function pressEnter(el: InputEl): void {
  const target = el instanceof HTMLElement ? el : null;
  if (!target) return;
  target.focus();
  const opts = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}

/**
 * Human-paced submission:
 * 1. randomized post-insert delay (submitDelayRangeMs)
 * 2. wait for the send button to become enabled
 * 3. randomized click coordinates (inner 60% of the bounding box)
 */
export async function submitInput(
  adapter: AdapterDef,
  settings: GuardSettings,
): Promise<boolean> {
  await sleep(randomFromRange(adapter.inputBehavior.submitDelayRangeMs));
  const btn = await waitForSendEnabled(adapter, settings);
  if (adapter.inputBehavior.submitMethod === 'enter') {
    const input = findInput(adapter);
    if (input) {
      pressEnter(input);
      return true;
    }
  }
  if (btn) {
    clickButton(btn, adapter.inputBehavior.randomizeClickCoords);
    return true;
  }
  return false;
}

/** Read the current input text (for prepend checks). */
export function readInputText(el: InputEl): string {
  if (isTextarea(el)) return el.value;
  return el.textContent ?? '';
}
