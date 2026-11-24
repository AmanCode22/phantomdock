// Native, React/ProseMirror-safe text insertion + human-paced submission.
// Zero prototype tampering: native property descriptors, dispatched events
// with bubbles, visibility-aware element selection, and randomized click coords.

import {
  clickPointInRect,
  randomFromRange,
  sleep,
  type GuardSettings,
} from '../shared/protocol';
import type { AdapterDef } from '../adapters/schema';

export type InputEl = HTMLTextAreaElement | HTMLElement;

/** Check whether an element is actually rendered and visible on screen. */
export function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function queryVisibleFirst<T extends HTMLElement>(selector: string): T | null {
  try {
    const all = [...document.querySelectorAll<T>(selector)];
    if (!all.length) return null;
    const visible = all.find((el) => isElementVisible(el));
    return visible ?? all[0];
  } catch {
    return null;
  }
}

export function findInput(adapter: AdapterDef): InputEl | null {
  return queryVisibleFirst<InputEl>(adapter.selectors.inputBox);
}

export function findSendButton(adapter: AdapterDef): HTMLElement | null {
  return queryVisibleFirst<HTMLElement>(adapter.selectors.sendButton);
}

export function isTextarea(el: InputEl): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function hasPayloadText(el: HTMLElement, payload: string): boolean {
  const actual = normalizeWs(el.innerText || el.textContent || '');
  const expected = normalizeWs(payload);
  if (!expected) return true;
  const probe = expected.slice(0, Math.min(48, expected.length));
  return actual.includes(probe);
}

/**
 * Insert text using native setters + dispatched input events.
 * - textarea: native value descriptor + React _valueTracker sync + input/change
 * - contenteditable: ClipboardEvent('paste') -> execCommand('insertText') ->
 *   paragraph DOM fallback, using whitespace-normalized verification so
 *   ProseMirror <p> conversions never cause double-insertion.
 */
export function insertText(el: InputEl, payload: string, clearBeforeInsert: boolean): boolean {
  try {
    el.focus();
    if (isTextarea(el)) {
      const prev = el.value;
      const next =
        clearBeforeInsert || !prev.trim()
          ? payload
          : `${payload}\n\n${prev}`;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, next);
      // Sync React's internal value tracker if present so onChange fires reliably.
      const tracker = (el as unknown as { _valueTracker?: { setValue?: (v: string) => void } })
        ._valueTracker;
      tracker?.setValue?.(prev);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: payload,
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    // contenteditable (ProseMirror / Lexical / Slate)
    const existing = readInputText(el).trim();
    const finalText =
      clearBeforeInsert || !existing
        ? payload
        : `${payload}\n\n${existing}`;

    // Always select all and delete so we have a clean deterministic insertion.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    try {
      document.execCommand('delete', false);
    } catch {
      /* ignore */
    }

    // Strategy 1: synthetic paste (natively handled by ProseMirror & Lexical).
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', finalText);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      /* DataTransfer/ClipboardEvent unavailable */
    }

    if (hasPayloadText(el, payload)) {
      return true;
    }

    // Strategy 2: execCommand('insertText').
    try {
      el.focus();
      document.execCommand('insertText', false, finalText);
    } catch {
      /* ignore */
    }

    if (hasPayloadText(el, payload)) {
      return true;
    }

    // Strategy 3: direct DOM paragraph insertion + input event.
    el.textContent = finalText;
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertFromPaste',
        data: finalText,
      }),
    );
    return hasPayloadText(el, payload);
  } catch {
    return false;
  }
}

/** Class-based disabled markers used by div-style send buttons. */
const DISABLED_CLASS_RE = /\b(?:disabled|ds-button--disabled|is-disabled)\b/;

export function isSendDisabled(btn: HTMLElement): boolean {
  return (
    ((btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) && btn.disabled) ||
    btn.getAttribute('aria-disabled') === 'true' ||
    DISABLED_CLASS_RE.test(btn.className || '')
  );
}

/** Wait until a visible, enabled send button is ready (rAF loop with timeout). */
export async function waitForSendEnabled(
  adapter: AdapterDef,
  settings: GuardSettings,
): Promise<HTMLElement | null> {
  const timeoutMs = settings.sendEnableTimeoutMs || adapter.inputBehavior.sendEnableTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = (): void => {
      const btn = findSendButton(adapter);
      if (btn && !isSendDisabled(btn)) {
        resolve(btn);
        return;
      }
      if (Date.now() >= deadline) {
        // Never return a disabled button — let caller fall back to Enter.
        resolve(null);
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
  const point =
    randomize && rect.width > 4 && rect.height > 4
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
 * 1. randomized post-insert delay (user settings submitDelayRangeMs)
 * 2. wait for the send button to become enabled
 * 3. click button (with randomized coords) or press Enter, with automatic
 *    Enter fallback if the send button stayed disabled or didn't clear input.
 */
export async function submitInput(
  adapter: AdapterDef,
  settings: GuardSettings,
): Promise<boolean> {
  const delayRange = settings.submitDelayRangeMs ?? adapter.inputBehavior.submitDelayRangeMs;
  await sleep(randomFromRange(delayRange));

  const input = findInput(adapter);
  if (adapter.inputBehavior.submitMethod === 'enter' && input) {
    pressEnter(input);
    return true;
  }

  const btn = await waitForSendEnabled(adapter, settings);
  if (btn) {
    clickButton(btn, adapter.inputBehavior.randomizeClickCoords);
    // Verify the click actually submitted; if input still has the full payload
    // after 300ms, fall back to Enter once.
    await sleep(300);
    const currentInput = findInput(adapter);
    if (currentInput && readInputText(currentInput).trim().length > 20) {
      pressEnter(currentInput);
    }
    return true;
  }

  if (input) {
    pressEnter(input);
    return true;
  }
  return false;
}

/** Read the current input text (for prepend checks). */
export function readInputText(el: InputEl): string {
  if (isTextarea(el)) return el.value;
  return el.innerText || el.textContent || '';
}
