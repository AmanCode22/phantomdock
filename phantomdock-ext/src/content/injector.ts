// Native, React/Vue/Svelte/ProseMirror-safe text insertion + human-paced submission.
// Zero prototype tampering: native property descriptors, priority-ordered
// visibility-aware selector matching, and randomized click coordinates.

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

/**
 * Split a comma-separated CSS selector list without splitting inside (...) or [...].
 * Allows evaluating selectors in explicit priority order rather than DOM tree order.
 */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < selector.length) {
        cur += selector[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      const trimmed = cur.trim();
      if (trimmed) parts.push(trimmed);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) parts.push(tail);
  return parts;
}

function isEditableAndEnabled(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly;
  }
  return el.getAttribute('aria-disabled') !== 'true';
}

/**
 * Evaluate selectors in priority order, returning the first visible match
 * (optionally filtered by a predicate). Falls back to the first connected match
 * if none report visible (e.g. headless/jsdom tests).
 */
function queryPriorityVisible<T extends HTMLElement>(
  selector: string,
  predicate?: (el: T) => boolean,
): T | null {
  const parts = splitSelectorList(selector);
  let fallback: T | null = null;

  for (const part of parts) {
    let matches: T[];
    try {
      matches = [...document.querySelectorAll<T>(part)];
    } catch {
      continue;
    }
    if (!matches.length) continue;
    const filtered = predicate ? matches.filter(predicate) : matches;
    const pool = filtered.length ? filtered : matches;
    const visible = pool.find((el) => isElementVisible(el));
    if (visible) return visible;
    if (!fallback) fallback = pool[0];
  }
  return fallback;
}

export function findInput(adapter: AdapterDef): InputEl | null {
  return queryPriorityVisible<InputEl>(adapter.selectors.inputBox, (el) => {
    if (!isEditableAndEnabled(el)) return false;
    // Avoid grabbing a textarea/contenteditable nested inside a chat message bubble.
    try {
      if (adapter.selectors.assistantMessage && el.closest(adapter.selectors.assistantMessage)) {
        return false;
      }
    } catch {
      /* ignore */
    }
    return true;
  });
}

export function findSendButton(adapter: AdapterDef): HTMLElement | null {
  return queryPriorityVisible<HTMLElement>(adapter.selectors.sendButton);
}

export function isTextarea(el: InputEl): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || el.tagName === 'TEXTAREA';
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function hasPayloadText(el: HTMLElement, payload: string): boolean {
  const raw = isTextarea(el) ? el.value : el.innerText || el.textContent || '';
  const actual = normalizeWs(raw);
  const expected = normalizeWs(payload);
  if (!expected) return true;
  const probe = expected.slice(0, Math.min(48, expected.length));
  return actual.includes(probe);
}

/**
 * Insert text using native setters + dispatched input events.
 * - textarea: native value descriptor + React _valueTracker sync +
 *   beforeinput/input/change/keyup events (works with React, Vue, Svelte, AntD)
 * - contenteditable: ClipboardEvent('paste') -> execCommand('insertText') ->
 *   paragraph DOM fallback, using whitespace-normalized verification so
 *   ProseMirror/TipTap <p> conversions never cause double-insertion.
 */
export function insertText(el: InputEl, payload: string, clearBeforeInsert: boolean): boolean {
  try {
    el.focus();
    el.click();

    if (isTextarea(el)) {
      const prev = el.value;
      const next =
        clearBeforeInsert || !prev.trim()
          ? payload
          : `${payload}\n\n${prev}`;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, next);
      } else {
        el.value = next;
      }
      // Sync React's internal value tracker with a guaranteed-different previous value.
      const tracker = (el as unknown as { _valueTracker?: { setValue?: (v: string) => void } })
        ._valueTracker;
      tracker?.setValue?.(prev === next ? '' : prev);

      try {
        el.setSelectionRange(next.length, next.length);
      } catch {
        /* ignore */
      }

      el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: payload,
        }),
      );
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: payload,
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keyup', {
          bubbles: true,
          key: ' ',
          code: 'Space',
        }),
      );
      return hasPayloadText(el, payload);
    }

    // contenteditable (ProseMirror / TipTap / Lexical / Slate)
    const existing = readInputText(el).trim();
    const finalText =
      clearBeforeInsert || !existing
        ? payload
        : `${payload}\n\n${existing}`;

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

    // Strategy 1: synthetic paste (natively handled by ProseMirror, TipTap & Lexical).
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
      el.dispatchEvent(new Event('change', { bubbles: true }));
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
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    // Strategy 3: paragraph DOM insertion + input/change events (ProseMirror/TipTap).
    el.replaceChildren();
    for (const line of finalText.split('\n')) {
      const p = document.createElement('p');
      if (line.length > 0) {
        p.textContent = line;
      } else {
        p.appendChild(document.createElement('br'));
      }
      el.appendChild(p);
    }
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertFromPaste',
        data: finalText,
      }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return hasPayloadText(el, payload);
  } catch {
    return false;
  }
}

/** Class-based disabled markers used by div-style send buttons. */
const DISABLED_CLASS_RE = /\b(?:disabled|ds-button--disabled|is-disabled|ant-btn-disabled)\b/;

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
 * 3. click button (with randomized coords) or press Enter, verifying the input
 *    clears and falling back to native click() -> Enter if needed.
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
    await sleep(320);
    const afterClick = findInput(adapter);
    if (afterClick && readInputText(afterClick).trim().length > 20) {
      // Some frameworks (e.g. Vue/AntD/Svelte wrappers) respond better to native click().
      btn.click();
      await sleep(250);
    }
    const afterNative = findInput(adapter);
    if (afterNative && readInputText(afterNative).trim().length > 20) {
      pressEnter(afterNative);
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
