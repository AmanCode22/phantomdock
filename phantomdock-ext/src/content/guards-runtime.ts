// GuardController: wires the pure guard state machine to the live DOM —
// active-tab gate, CAPTCHA/challenge circuit breaker, rate-limit banners,
// cooldown countdown, and the persistent STOP control.

import type { AdapterDef } from '../adapters/schema';
import type { GuardSettings } from '../shared/protocol';
import {
  checkGuards,
  clearBackoffStreak,
  initialGuardState,
  manualResume,
  pruneHourly,
  registerAutoSend,
  registerManualSend,
  tripCooldown,
  type GuardReason,
  type GuardRuntimeState,
  type GuardVerdict,
} from './guards';

export interface GuardUi {
  setBadge: (text: string | null) => void;
  onStateChange: (summary: GuardSummary) => void;
}

export interface GuardSummary {
  stopped: boolean;
  cooldownRemainingMs: number;
  cooldownReason: string | null;
  consecutiveAutoTurns: number;
  hourlyTurns: number;
  blocked: GuardReason | null;
}

const CHALLENGE_EXTRA_SELECTORS = [
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='turnstile']",
  "iframe[src*='arkoselabs']",
  "iframe[src*='funcaptcha']",
  "iframe[src*='hcaptcha']",
  "[class*='captcha']",
];

export class GuardController {
  state: GuardRuntimeState;
  private timers: number[] = [];
  private watchers: MutationObserver[] = [];
  private lastVerdict: GuardVerdict = { ok: true };

  constructor(
    private adapter: AdapterDef,
    private settings: GuardSettings,
    private ui: GuardUi,
    private persist: (fn: (s: GuardRuntimeState) => void) => void,
    state?: GuardRuntimeState,
  ) {
    this.state = state ?? initialGuardState();
  }

  start(): void {
    // Active-tab gate.
    document.addEventListener('visibilitychange', this.onVisibility);
    // Challenge + rate-limit watchers (interval sweep; MutationObserver alone
    // can miss iframes injected deep in portals).
    const sweep = window.setInterval(() => this.sweepBanners(), 1500);
    this.timers.push(sweep);
    const bannerObserver = new MutationObserver(() => this.sweepBanners());
    bannerObserver.observe(document.body, { childList: true, subtree: true });
    this.watchers.push(bannerObserver);
    // Cooldown countdown ticker.
    const tick = window.setInterval(() => this.emit(), 1000);
    this.timers.push(tick);
  }

  stop(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.watchers) w.disconnect();
    this.watchers = [];
  }

  updateSettings(settings: GuardSettings): void {
    this.settings = settings;
    this.emit();
  }

  private onVisibility = (): void => {
    this.emit();
  };

  private sweepBanners(): void {
    const now = Date.now();
    const challenge =
      this.detect(this.adapter.selectors.challengeBanner) ||
      CHALLENGE_EXTRA_SELECTORS.some((s) => this.detect(s));
    const rateLimit = this.detect(this.adapter.selectors.rateLimitBanner);

    if (challenge && this.state.cooldownUntil < now && !this.state.stopped) {
      const secs = tripCooldown(this.state, this.effectiveSettings(), now, 'CHALLENGE');
      this.persist(() => undefined);
      this.ui.setBadge('CAPTCHA');
      this.ui.onStateChange(this.summary());
      console.warn(`[pdock] challenge detected — cooldown ${secs}s (COOLDOWN_PAUSED)`);
    }
    if (rateLimit && this.state.cooldownUntil < now && !this.state.stopped) {
      const secs = tripCooldown(this.state, this.effectiveSettings(), now, 'RATE_LIMIT');
      this.ui.setBadge('COOL');
      console.warn(`[pdock] rate limit detected — backoff ${secs}s`);
    }
    this.emit();
  }

  private detect(selector: string): boolean {
    try {
      return Boolean(document.querySelector(selector));
    } catch {
      return false;
    }
  }

  private effectiveSettings(): GuardSettings {
    // Adapter loop protection and global settings merge; the more conservative
    // (smaller) budget wins.
    const s = { ...this.settings };
    s.maxConsecutiveAutoTurns = Math.min(
      s.maxConsecutiveAutoTurns,
      this.adapter.loopProtection.maxConsecutiveAutoTurns,
    );
    s.maxAutomatedTurnsPerHour = Math.min(
      s.maxAutomatedTurnsPerHour,
      this.adapter.loopProtection.maxAutomatedTurnsPerHour,
    );
    s.requireVisibleTab = s.requireVisibleTab && this.adapter.loopProtection.requireVisibleTab;
    return s;
  }

  /** The pre-send gate. Returns ok or the blocking reason. */
  check(): GuardVerdict {
    const now = Date.now();
    pruneHourly(this.state, now);
    const verdict = checkGuards({
      settings: this.effectiveSettings(),
      state: this.state,
      now,
      visible: document.visibilityState === 'visible',
      challengeDetected: this.detect(this.adapter.selectors.challengeBanner),
      rateLimitDetected: this.detect(this.adapter.selectors.rateLimitBanner),
    });
    this.lastVerdict = verdict;
    this.emit();
    return verdict;
  }

  get blockedReason(): GuardReason | null {
    return this.lastVerdict.ok ? null : this.lastVerdict.reason;
  }

  registerAutoSend(): void {
    registerAutoSend(this.state, Date.now());
    clearBackoffStreak(this.state);
    this.persist(() => undefined);
    this.emit();
  }

  registerManualSend(): void {
    registerManualSend(this.state);
    this.persist(() => undefined);
    this.emit();
  }

  setStopped(stopped: boolean): void {
    if (stopped) {
      this.state.stopped = true;
      this.ui.setBadge('STOP');
    } else {
      manualResume(this.state);
      this.ui.setBadge(null);
    }
    this.persist(() => undefined);
    this.emit();
  }

  summary(): GuardSummary {
    const now = Date.now();
    pruneHourly(this.state, now);
    return {
      stopped: this.state.stopped,
      cooldownRemainingMs: Math.max(0, this.state.cooldownUntil - now),
      cooldownReason: this.state.cooldownReason,
      consecutiveAutoTurns: this.state.consecutiveAutoTurns,
      hourlyTurns: this.state.hourlyTimestamps.length,
      blocked: this.lastVerdict.ok ? null : this.lastVerdict.reason,
    };
  }

  private emit(): void {
    this.ui.onStateChange(this.summary());
  }
}
