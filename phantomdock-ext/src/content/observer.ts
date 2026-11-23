// Passive MutationObserver: watches the chat for (a) streaming completion of
// assistant messages (streaming indicator gone + DOM quiet window), then parses
// pdock_call blocks; and (b) new user messages containing <tool_result>, which
// collapse into compact pills.

import type { AdapterDef } from '../adapters/schema';
import { parsePdockCalls, type ParsedCall } from './parser';

const QUIET_WINDOW_MS = 800;

export interface TurnEvents {
  /** Fired once when a completed assistant message contains tool calls. */
  onToolTurn: (calls: ParsedCall[], assistantEl: HTMLElement | null) => void;
  /** Fired when a new user message containing tool_result appears. */
  onToolResultUserMessage: (userEl: HTMLElement) => void;
}

interface PendingStream {
  timer: number | null;
  assistantEl: HTMLElement | null;
}

export class StreamObserver {
  private observer: MutationObserver | null = null;
  private pending: PendingStream | null = null;
  private lastHandledAssistantText = '';
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
    this.markExistingUsers();
    this.observer = new MutationObserver(() => this.onDomChange());
    const root = document.querySelector(this.adapter.selectors.chatContainer) ?? document.body;
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.active = false;
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Pause tool-turn handling while a batch is awaiting approval. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.lastHandledAssistantText = '';
  }

  private onDomChange(): void {
    if (!this.active) return;
    this.checkForToolResultUsers();
    this.trackStreaming();
  }

  /** Detect new user bubbles carrying <tool_result> (collapse into pills). */
  private checkForToolResultUsers(): void {
    const users = document.querySelectorAll<HTMLElement>(this.adapter.selectors.userMessage);
    for (const el of users) {
      if (this.seenUserElements.has(el)) continue;
      this.seenUserElements.add(el);
      const text = el.textContent ?? '';
      if (text.includes('<tool_result')) {
        this.events.onToolResultUserMessage(el);
      }
    }
  }

  /** Track streaming end: indicator present -> gone + quiet window. */
  private trackStreaming(): void {
    const streaming = document.querySelector(this.adapter.selectors.streamingIndicator);
    if (streaming) {
      // Still generating: hold any pending completion.
      if (this.pending?.timer) {
        clearTimeout(this.pending.timer);
        this.pending.timer = null;
      }
      return;
    }
    const lastAssistant = this.lastAssistantEl();
    if (!lastAssistant) return;
    const text = this.assistantText(lastAssistant);
    if (!text.trim()) return;

    if (!this.pending) {
      this.pending = { timer: null, assistantEl: lastAssistant };
    } else {
      this.pending.assistantEl = lastAssistant;
    }
    if (this.pending.timer) clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => {
      this.pending = null;
      this.onStreamQuiet();
    }, QUIET_WINDOW_MS) as unknown as number;
  }

  private onStreamQuiet(): void {
    if (this.paused) return;
    const el = this.lastAssistantEl();
    if (!el) return;
    const text = this.assistantText(el);
    if (!text || text === this.lastHandledAssistantText) return;
    const parsed = parsePdockCalls(text);
    if (parsed.hasCalls) {
      this.lastHandledAssistantText = text;
      this.events.onToolTurn(parsed.calls, el);
    }
  }

  lastAssistantEl(): HTMLElement | null {
    const els = document.querySelectorAll<HTMLElement>(this.adapter.selectors.assistantMessage);
    return els.length ? els[els.length - 1] : null;
  }

  assistantText(el: HTMLElement): string {
    const body = el.querySelector(this.adapter.selectors.messageMarkdownBody);
    return (body ?? el).textContent ?? '';
  }

  private markExistingUsers(): void {
    const users = document.querySelectorAll(this.adapter.selectors.userMessage);
    for (const el of users) this.seenUserElements.add(el);
  }
}
