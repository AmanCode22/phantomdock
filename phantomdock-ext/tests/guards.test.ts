import { describe, expect, it } from 'vitest';
import {
  checkGuards,
  clearBackoffStreak,
  initialGuardState,
  manualResume,
  pruneHourly,
  registerAutoSend,
  registerManualSend,
  tripCooldown,
} from '../src/content/guards';
import { DEFAULT_SETTINGS, type GuardSettings } from '../src/shared/protocol';

const T0 = 1_700_000_000_000;

function settings(patch: Partial<GuardSettings> = {}): GuardSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('checkGuards', () => {
  it('allows a clean send', () => {
    const v = checkGuards({
      settings: settings(),
      state: initialGuardState(),
      now: T0,
      visible: true,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v.ok).toBe(true);
  });

  it('blocks hidden tabs when the active-tab gate is on', () => {
    const v = checkGuards({
      settings: settings(),
      state: initialGuardState(),
      now: T0,
      visible: false,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v).toMatchObject({ ok: false, reason: 'HIDDEN_TAB' });
  });

  it('allows hidden tabs when the gate is disabled', () => {
    const v = checkGuards({
      settings: settings({ requireVisibleTab: false }),
      state: initialGuardState(),
      now: T0,
      visible: false,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v.ok).toBe(true);
  });

  it('blocks on challenge and rate-limit banners', () => {
    for (const [challenge, rate, reason] of [
      [true, false, 'CHALLENGE'],
      [false, true, 'RATE_LIMIT'],
    ] as const) {
      const v = checkGuards({
        settings: settings(),
        state: initialGuardState(),
        now: T0,
        visible: true,
        challengeDetected: challenge,
        rateLimitDetected: rate,
      });
      expect(v).toMatchObject({ ok: false, reason });
    }
  });

  it('enforces consecutive auto-turn budget', () => {
    const st = initialGuardState();
    st.consecutiveAutoTurns = 15;
    const v = checkGuards({
      settings: settings(),
      state: st,
      now: T0,
      visible: true,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v).toMatchObject({ ok: false, reason: 'BUDGET_CONSECUTIVE' });
  });

  it('enforces the rolling hourly budget with 60-minute pruning', () => {
    const st = initialGuardState();
    st.hourlyTimestamps = Array.from(
      { length: 60 },
      (_, i) => T0 - 59 * 60 * 1000 + i * 1000,
    );
    const v = checkGuards({
      settings: settings(),
      state: st,
      now: T0,
      visible: true,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v).toMatchObject({ ok: false, reason: 'BUDGET_HOURLY' });

    // Once the old timestamps age out, the budget frees up again.
    const later = T0 + 2 * 60 * 1000;
    const v2 = checkGuards({
      settings: settings(),
      state: st,
      now: later,
      visible: true,
      challengeDetected: false,
      rateLimitDetected: false,
    });
    expect(v2.ok).toBe(true);
  });

  it('blocks while stopped or in cooldown', () => {
    const st = initialGuardState();
    st.stopped = true;
    expect(
      checkGuards({
        settings: settings(),
        state: st,
        now: T0,
        visible: true,
        challengeDetected: false,
        rateLimitDetected: false,
      }),
    ).toMatchObject({ ok: false, reason: 'STOPPED' });

    const st2 = initialGuardState();
    st2.cooldownUntil = T0 + 30_000;
    expect(
      checkGuards({
        settings: settings(),
        state: st2,
        now: T0,
        visible: true,
        challengeDetected: false,
        rateLimitDetected: false,
      }),
    ).toMatchObject({ ok: false, reason: 'COOLDOWN' });
  });
});

describe('budgets and backoff', () => {
  it('registerAutoSend counts consecutive + hourly, manual send resets consecutive', () => {
    const st = initialGuardState();
    registerAutoSend(st, T0);
    registerAutoSend(st, T0 + 1000);
    expect(st.consecutiveAutoTurns).toBe(2);
    expect(st.hourlyTimestamps.length).toBe(2);
    registerManualSend(st);
    expect(st.consecutiveAutoTurns).toBe(0);
    expect(st.hourlyTimestamps.length).toBe(2);
  });

  it('pruneHourly drops timestamps older than 60 minutes', () => {
    const st = initialGuardState();
    st.hourlyTimestamps = [T0 - 61 * 60 * 1000, T0 - 59 * 60 * 1000, T0];
    pruneHourly(st, T0);
    expect(st.hourlyTimestamps.length).toBe(2);
  });

  it('tripCooldown applies exponential backoff capped at maxCooldownSeconds', () => {
    const s = settings({ cooldownSeconds: 60, backoffMultiplier: 2, maxCooldownSeconds: 900 });
    const st = initialGuardState();
    expect(tripCooldown(st, s, T0, 'RATE_LIMIT')).toBe(60); // 60 * 2^0
    expect(tripCooldown(st, s, T0, 'RATE_LIMIT')).toBe(120); // 60 * 2^1
    expect(tripCooldown(st, s, T0, 'RATE_LIMIT')).toBe(240); // 60 * 2^2
    expect(tripCooldown(st, s, T0, 'RATE_LIMIT')).toBe(480); // 60 * 2^3
    expect(tripCooldown(st, s, T0, 'RATE_LIMIT')).toBe(900); // 960 capped at 900
    expect(st.cooldownUntil).toBe(T0 + 900_000);
    expect(st.cooldownReason).toBe('rate-limit backoff');
  });

  it('clearBackoffStreak resets escalation and manualResume unlocks everything', () => {
    const s = settings();
    const st = initialGuardState();
    tripCooldown(st, s, T0, 'CHALLENGE');
    st.stopped = true;
    clearBackoffStreak(st);
    expect(st.backoffStreak).toBe(0);
    manualResume(st);
    expect(st.stopped).toBe(false);
    expect(st.cooldownUntil).toBe(0);
  });
});
