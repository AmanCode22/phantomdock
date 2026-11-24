// GuardController: wires the pure guard state machine to the live DOM —
// active-tab gate, CAPTCHA/challenge circuit breaker, rate-limit banners,
// cooldown countdown, and the persistent STOP control.

import type { AdapterDef } from '../adapters/schema';
import type { GuardSettings } from '../shared/protocol';
import { isElementVisible } from './injector';
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
];

export class GuardController {
  state: GuardRuntimeState;
  private timers: ReturnType<typeof setInterval>[] = [];
  private watchers: MutationObserver[] = [];
  private lastVerdict: GuardVerdict = { ok: true };

  constructor(
    private adapter: AdapterDef,
    private settings: GuardSettings,
    private ui: GuardUi,
    private onCooldownTrip: (until: number, streak: number, reason: string) => void,
    state?: GuardRuntimeState,
  ) {
    this.state = state ?? initialGuardState();
  }

  start(): void {
    document.addEventListener('visibilitychange', this.onVisibility);
    const sweep = setInterval(() => this.sweepBanners(), 2000);
    this.timers.push(sweep);
    const tick = setInterval(() => this.emit(), 1000);
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

  updateAdapter(adapter: AdapterDef): void {
    this.adapter = adapter;
    this.emit();
  }

  hydrateState(state: GuardRuntimeState): void {
    this.state = state;
    this.emit();
  }

  private onVisibility = (): void => {
    this.emit();
  };

  isChallengeVisible(): boolean {
    if (!this.settings.challengeWatch) return false;
    return (
      this.detectVisible(this.adapter.selectors.challengeBanner, true) ||
      CHALLENGE_EXTRA_SELECTORS.some((s) => this.detectVisible(s, true))
    );
  }

  isRateLimitVisible(): boolean {
    return this.detectVisible(this.adapter.selectors.rateLimitBanner, false);
  }

  private sweepBanners(): void {
    const now = Date.now();
    const challenge = this.isChallengeVisible();
    const rateLimit = this.isRateLimitVisible();

    if (challenge && this.state.cooldownUntil < now && !this.state.stopped) {
      const secs = tripCooldown(this.state, this.effectiveSettings(), now, 'CHALLENGE');
      this.onCooldownTrip(
        this.state.cooldownUntil,
        this.state.backoffStreak,
        this.state.cooldownReason ?? 'challenge breaker',
      );
      this.ui.setBadge('CAPTCHA');
      console.warn(`[pdock] challenge detected — cooldown ${secs}s`);
    } else if (rateLimit && this.state.cooldownUntil < now && !this.state.stopped) {
      const secs = tripCooldown(this.state, this.effectiveSettings(), now, 'RATE_LIMIT');
      this.onCooldownTrip(
        this.state.cooldownUntil,
        this.state.backoffStreak,
        this.state.cooldownReason ?? 'rate-limit backoff',
      );
      this.ui.setBadge('COOL');
      console.warn(`[pdock] rate limit detected — backoff ${secs}s`);
    }
    this.emit();
  }

  /**
   * Only return true if a matching element is actually visible on screen
   * (and has non-empty text unless it is an iframe). Prevents false positives
   * from hidden toast containers or empty error slots.
   */
  private detectVisible(selector: string, allowEmptyIframe: boolean): boolean {
    try {
      const matches = document.querySelectorAll(selector);
      for (const el of matches) {
        if (!isElementVisible(el)) continue;
        if (allowEmptyIframe && el.tagName === 'IFRAME') return true;
        if ((el.textContent ?? '').trim().length > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private effectiveSettings(): GuardSettings {
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
      challengeDetected: this.isChallengeVisible(),
      rateLimitDetected: this.isRateLimitVisible(),
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
    this.lastVerdict = { ok: true };
    this.emit();
  }

  registerManualSend(): void {
    registerManualSend(this.state);
    this.emit();
  }

  setStopped(stopped: boolean): void {
    if (stopped) {
      this.state.stopped = true;
      this.ui.setBadge('STOP');
    } else {
      manualResume(this.state);
      this.lastVerdict = { ok: true };
      this.ui.setBadge(null);
    }
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
