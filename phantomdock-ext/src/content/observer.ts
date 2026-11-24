// Passive MutationObserver: watches the chat for (a) streaming completion of
// assistant messages (streaming indicator gone + DOM quiet window), then parses
// pdock_call blocks; (b) new user messages containing <tool_result>, which
// collapse into compact pills; and (c) SPA route changes (switching threads).
//
// Observes document.body with throttled callbacks + attribute watching so
// React container unmounts and attribute-driven stream completions never get missed.

import type { AdapterDef } from '../adapters/schema';
import { isElementVisible } from './injector';
import { extractResultNames, parsePdockCallsFromElement, type ParsedCall } from './parser';

/**
 * A user message only counts as a tool-result bubble when it carries a real
 * result envelope (id/count attributes). The workspace manifest mentions bare
 * `<tool_result>` in its instructions and must NOT match.
 */
const TOOL_RESULT_MSG_RE = /<tool_results?\s[^>]*\b(?:id|count)="/;

const QUIET_WINDOW_MS = 850;
const MUTATION_THROTTLE_MS = 120;
const FALLBACK_POLL_MS = 1000;

export interface TurnEvents {
  /** Fired once when a completed assistant message contains tool calls. */
  onToolTurn: (calls: ParsedCall[], assistantEl: HTMLElement | null) => void;
  /** Fired when a new user message containing tool_result appears. */
  onToolResultUserMessage: (userEl: HTMLElement, toolNames: string[]) => void;
  /** Fired when the streaming state toggles (for ControlBar status). */
  onStreamingChange?: (streaming: boolean) => void;
  /** Fired when the SPA navigates to a different chat/thread URL. */
  onThreadChange?: () => void;
}

export class StreamObserver {
  private observer: MutationObserver | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastHandledAssistantText = '';
  private lastHref = '';
  private wasStreaming = false;
  private seenUserElements = new WeakSet<Element>();
  private active = false;
  private paused = false;

  constructor(
    private adapter: AdapterDef,
    private events: TurnEvents,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastHref = location.href;
    this.markExistingUsers();

    this.observer = new MutationObserver(() => this.scheduleDomCheck());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-talvt-turn-state',
        'class',
        'disabled',
        'aria-disabled',
        'aria-label',
        'data-testid',
      ],
    });

    window.addEventListener('popstate', this.checkRouteChange);
    window.addEventListener('hashchange', this.checkRouteChange);
    this.pollTimer = setInterval(() => {
      this.checkRouteChange();
      if (!this.paused) {
        this.trackStreaming();
      }
    }, FALLBACK_POLL_MS);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.active = false;
    window.removeEventListener('popstate', this.checkRouteChange);
    window.removeEventListener('hashchange', this.checkRouteChange);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.quietTimer = null;
    this.throttleTimer = null;
    this.pollTimer = null;
  }

  /** Hot-reload adapter selectors without restarting the extension. */
  updateAdapter(adapter: AdapterDef): void {
    this.adapter = adapter;
    this.markExistingUsers();
    this.snapshotLastAssistant();
  }

  /** Pause tool-turn handling while a batch is awaiting approval. */
  pause(): void {
    this.paused = true;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  /**
   * Resume watching for the next assistant turn.
   * Note: callers should call snapshotLastAssistant() BEFORE submitting a
   * reply so fast model responses are never accidentally swallowed.
   */
  resume(snapshotNow = false): void {
    this.paused = false;
    if (snapshotNow) {
      this.snapshotLastAssistant();
    }
    this.scheduleDomCheck();
  }

  /**
   * Seed the handled-text baseline with the current last assistant message so
   * it is never re-fired (after history hydration or right before a reply).
   */
  snapshotLastAssistant(): void {
    const el = this.lastAssistantEl();
    this.lastHandledAssistantText = el ? this.assistantText(el) : '';
  }

  isStreamingNow(): boolean {
    try {
      const matches = [...document.querySelectorAll(this.adapter.selectors.streamingIndicator)];
      return matches.some((el) => isElementVisible(el));
    } catch {
      return false;
    }
  }

  private checkRouteChange = (): void => {
    if (!this.active) return;
    if (location.href !== this.lastHref) {
      this.lastHref = location.href;
      this.lastHandledAssistantText = '';
      this.wasStreaming = false;
      if (this.quietTimer) {
        clearTimeout(this.quietTimer);
        this.quietTimer = null;
      }
      this.markExistingUsers();
      this.events.onThreadChange?.();
    }
  };

  private scheduleDomCheck(): void {
    if (!this.active) return;
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.onDomChange();
    }, MUTATION_THROTTLE_MS);
  }

  private onDomChange(): void {
    if (!this.active) return;
    this.checkRouteChange();
    this.checkForToolResultUsers();
    this.trackStreaming();
  }

  /** Detect new user bubbles carrying <tool_result> (collapse into pills). */
  private checkForToolResultUsers(): void {
    let users: NodeListOf<HTMLElement>;
    try {
      users = document.querySelectorAll<HTMLElement>(this.adapter.selectors.userMessage);
    } catch {
      return;
    }
    for (const el of users) {
      if (this.seenUserElements.has(el)) continue;
      this.seenUserElements.add(el);
      const text = el.textContent ?? '';
      if (TOOL_RESULT_MSG_RE.test(text)) {
        const names = extractResultNames(text);
        this.events.onToolResultUserMessage(el, names);
      }
    }
  }

  /** Track streaming end: indicator present -> gone + quiet window. */
  private trackStreaming(): void {
    if (this.paused) return;
    const streaming = this.isStreamingNow();
    if (streaming !== this.wasStreaming) {
      this.wasStreaming = streaming;
      this.events.onStreamingChange?.(streaming);
    }

    if (streaming) {
      if (this.quietTimer) {
        clearTimeout(this.quietTimer);
        this.quietTimer = null;
      }
      return;
    }

    const lastAssistant = this.lastAssistantEl();
    if (!lastAssistant) return;
    const text = this.assistantText(lastAssistant);
    if (!text.trim() || text === this.lastHandledAssistantText) return;

    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.onStreamQuiet();
    }, QUIET_WINDOW_MS);
  }

  private onStreamQuiet(): void {
    if (this.paused || this.isStreamingNow()) return;
    const el = this.lastAssistantEl();
    if (!el) return;
    const text = this.assistantText(el);
    if (!text || text === this.lastHandledAssistantText) return;

    const parsed = parsePdockCallsFromElement(
      el,
      this.adapter.selectors.messageMarkdownBody,
      this.adapter.selectors.userMessage,
    );
    if (parsed.calls.length > 0) {
      this.lastHandledAssistantText = text;
      this.events.onToolTurn(parsed.calls, el);
    }
  }

  lastAssistantEl(): HTMLElement | null {
    try {
      const els = document.querySelectorAll<HTMLElement>(this.adapter.selectors.assistantMessage);
      return els.length ? els[els.length - 1] : null;
    } catch {
      return null;
    }
  }

  assistantText(el: HTMLElement): string {
    try {
      const bodies = [...el.querySelectorAll(this.adapter.selectors.messageMarkdownBody)];
      if (!bodies.length) return el.textContent ?? '';
      return bodies.map((b) => b.textContent ?? '').join('\n');
    } catch {
      return el.textContent ?? '';
    }
  }

  private markExistingUsers(): void {
    try {
      const users = document.querySelectorAll(this.adapter.selectors.userMessage);
      for (const el of users) this.seenUserElements.add(el);
    } catch {
      /* invalid selector */
    }
  }
}
