// Behavioral anti-ban guards: pure state machine (unit tested). The DOM-facing
// GuardController in guards-runtime.ts feeds events into these functions.

import type { GuardSettings } from '../shared/protocol';

export type GuardReason =
  | 'STOPPED'
  | 'HIDDEN_TAB'
  | 'CHALLENGE'
  | 'RATE_LIMIT'
  | 'BUDGET_CONSECUTIVE'
  | 'BUDGET_HOURLY'
  | 'COOLDOWN';

export interface GuardRuntimeState {
  stopped: boolean;
  consecutiveAutoTurns: number;
  /** Epoch ms of automated sends within the rolling 60-minute window. */
  hourlyTimestamps: number[];
  /** Epoch ms until which sending is locked (cooldown / backoff). */
  cooldownUntil: number;
  /** Consecutive rate-limit/challenge trips for exponential backoff. */
  backoffStreak: number;
  cooldownReason: string | null;
}

export function initialGuardState(): GuardRuntimeState {
  return {
    stopped: false,
    consecutiveAutoTurns: 0,
    hourlyTimestamps: [],
    cooldownUntil: 0,
    backoffStreak: 0,
    cooldownReason: null,
  };
}

export interface GuardInputs {
  settings: GuardSettings;
  state: GuardRuntimeState;
  now: number;
  visible: boolean;
  challengeDetected: boolean;
  rateLimitDetected: boolean;
}

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardReason; detail: string };

/** Prune the rolling hourly window to the last 60 minutes. */
export function pruneHourly(state: GuardRuntimeState, now: number): void {
  const cutoff = now - 60 * 60 * 1000;
  state.hourlyTimestamps = state.hourlyTimestamps.filter((t) => t >= cutoff);
}

export function checkGuards(i: GuardInputs): GuardVerdict {
  const { settings, state, now } = i;
  pruneHourly(state, now);

  if (state.stopped) {
    return { ok: false, reason: 'STOPPED', detail: 'Automation stopped by the user' };
  }
  if (state.cooldownUntil > now) {
    return {
      ok: false,
      reason: 'COOLDOWN',
      detail: `Cooldown active (${state.cooldownReason ?? 'backoff'}) for ${Math.ceil(
        (state.cooldownUntil - now) / 1000,
      )}s`,
    };
  }
  if (settings.requireVisibleTab && !i.visible) {
    return {
      ok: false,
      reason: 'HIDDEN_TAB',
      detail: 'Active-tab gate: tab is not visible (WAITING_FOR_FOCUS)',
    };
  }
  if (i.challengeDetected) {
    return {
      ok: false,
      reason: 'CHALLENGE',
      detail: 'CAPTCHA / challenge detected (COOLDOWN_PAUSED)',
    };
  }
  if (i.rateLimitDetected) {
    return { ok: false, reason: 'RATE_LIMIT', detail: 'Rate-limit banner detected' };
  }
  if (state.consecutiveAutoTurns >= settings.maxConsecutiveAutoTurns) {
    return {
      ok: false,
      reason: 'BUDGET_CONSECUTIVE',
      detail: `Consecutive auto-turn budget reached (${state.consecutiveAutoTurns}/${settings.maxConsecutiveAutoTurns})`,
    };
  }
  if (state.hourlyTimestamps.length >= settings.maxAutomatedTurnsPerHour) {
    return {
      ok: false,
      reason: 'BUDGET_HOURLY',
      detail: `Hourly turn budget reached (${state.hourlyTimestamps.length}/${settings.maxAutomatedTurnsPerHour})`,
    };
  }
  return { ok: true };
}

/** Record a successful automated send. */
export function registerAutoSend(state: GuardRuntimeState, now: number): void {
  pruneHourly(state, now);
  state.consecutiveAutoTurns += 1;
  state.hourlyTimestamps.push(now);
}

/** A manual user send resets the consecutive-auto-turn counter. */
export function registerManualSend(state: GuardRuntimeState): void {
  state.consecutiveAutoTurns = 0;
}

/**
 * Trip the cooldown with exponential backoff:
 * cooldown = baseCooldown * multiplier^(streak - 1), capped at maxCooldownSeconds.
 * Returns the applied cooldown in seconds.
 */
export function tripCooldown(
  state: GuardRuntimeState,
  settings: GuardSettings,
  now: number,
  reason: 'CHALLENGE' | 'RATE_LIMIT',
): number {
  state.backoffStreak += 1;
  const base = settings.cooldownSeconds;
  const factor = Math.pow(settings.backoffMultiplier, state.backoffStreak - 1);
  const secs = Math.min(base * factor, settings.maxCooldownSeconds);
  state.cooldownUntil = now + secs * 1000;
  state.cooldownReason = reason === 'CHALLENGE' ? 'challenge breaker' : 'rate-limit backoff';
  return secs;
}

/** A successful human-paced send clears the backoff streak. */
export function clearBackoffStreak(state: GuardRuntimeState): void {
  state.backoffStreak = 0;
  state.cooldownReason = null;
}

/** Manual resume: clear cooldown + stop. */
export function manualResume(state: GuardRuntimeState): void {
  state.stopped = false;
  state.cooldownUntil = 0;
  state.backoffStreak = 0;
  state.cooldownReason = null;
}
