// Floating control bar: Attach Workspace / Attach Skill / STOP / Cooldown /
// turn-budget status / live connection dot / toast feedback — always accessible
// inside the closed Shadow DOM.

import type { SkillSummary } from '../../shared/protocol';
import type { GuardSummary } from '../guards-runtime';
import { getShadowRoot, h } from './shadow';

export interface ControlBarCallbacks {
  onAttachWorkspace: () => void;
  onAttachSkill: (name: string) => void;
  onStopToggle: (stopped: boolean) => void;
  onCancelBatch?: () => void;
}

export class ControlBar {
  private el: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private dotEl: HTMLSpanElement;
  private stopBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private statusEl: HTMLSpanElement;
  private budgetEl: HTMLSpanElement;
  private skillMenu: HTMLDivElement;
  private stopped = false;
  private bound = false;
  private boundLabel = '';
  private streaming = false;
  private lastGuard: GuardSummary | null = null;

  constructor(
    private callbacks: ControlBarCallbacks,
    private skills: SkillSummary[],
    bound: boolean,
  ) {
    this.bound = bound;
    const root = getShadowRoot();

    this.dotEl = h('span', { class: `dot ${bound ? 'on' : ''}` });
    this.stopBtn = h('button', {
      class: 'btn danger',
      text: 'STOP',
      onclick: () => {
        this.stopped = !this.stopped;
        this.callbacks.onStopToggle(this.stopped);
        this.renderStop();
        this.renderStatus();
      },
    });
    this.cancelBtn = h('button', {
      class: 'btn',
      text: 'Cancel Turn',
      style: 'display:none;',
      onclick: () => this.callbacks.onCancelBatch?.(),
    });
    this.statusEl = h('span', { class: 'dim', text: bound ? 'ready' : 'not paired' });
    this.budgetEl = h('span', { class: 'dim mono' });
    this.skillMenu = h('div', {
      class: 'panel',
      style: 'position:absolute;bottom:48px;right:0;min-width:260px;max-height:260px;overflow-y:auto;padding:8px;display:none;pointer-events:auto;',
    });
    this.toastEl = h('div', {
      class: 'toast',
      style: 'display:none;pointer-events:auto;',
    });

    const skillBtn = h('button', {
      class: 'btn',
      text: 'Skills',
      onclick: () => {
        const show = this.skillMenu.style.display === 'none';
        this.skillMenu.style.display = show ? 'block' : 'none';
        if (show) this.renderSkillMenu();
      },
    });
    const wsBtn = h('button', {
      class: 'btn primary',
      text: 'Attach Workspace',
      onclick: () => this.callbacks.onAttachWorkspace(),
    });

    this.el = h(
      'div',
      {
        class: 'panel',
        style: 'position:relative;display:flex;gap:8px;padding:8px 10px;align-items:center;pointer-events:auto;',
      },
      [
        this.dotEl,
        wsBtn,
        skillBtn,
        this.cancelBtn,
        this.stopBtn,
        this.budgetEl,
        this.statusEl,
        this.skillMenu,
      ],
    );
    root.float.append(this.toastEl, this.el);
    this.renderStop();
    this.renderStatus();
  }

  private renderStop(): void {
    this.stopBtn.textContent = this.stopped ? 'RESUME' : 'STOP';
    this.stopBtn.classList.toggle('danger', !this.stopped);
    this.stopBtn.classList.toggle('primary', this.stopped);
  }

  private renderSkillMenu(): void {
    this.skillMenu.replaceChildren();
    if (!this.skills.length) {
      this.skillMenu.append(
        h('div', {
          class: 'dim',
          text: this.bound
            ? 'No skills discovered by pdock.'
            : 'Pair with pdock first to load skills.',
        }),
      );
      return;
    }
    for (const s of this.skills) {
      this.skillMenu.append(
        h(
          'button',
          {
            class: 'btn ghost',
            style: 'display:block;width:100%;text-align:left;margin:2px 0;white-space:normal;',
            onclick: () => {
              this.skillMenu.style.display = 'none';
              this.callbacks.onAttachSkill(s.name);
            },
          },
          [
            h('div', { text: s.name, style: 'font-weight:600;font-size:12px;' }),
            h('div', { class: 'dim', text: s.description }),
          ],
        ),
      );
    }
  }

  private renderStatus(): void {
    const g = this.lastGuard;
    if (g?.stopped) {
      this.dotEl.className = 'dot off';
      this.statusEl.textContent = 'STOPPED';
      return;
    }
    if (!this.bound) {
      this.dotEl.className = 'dot';
      this.statusEl.textContent = 'not paired';
      return;
    }

    const parts: string[] = [];
    if (g && g.cooldownRemainingMs > 0) {
      const s = Math.ceil(g.cooldownRemainingMs / 1000);
      parts.push(`cooldown ${Math.floor(s / 60)}m${s % 60}s`);
    } else if (g?.blocked) {
      parts.push(humanReason(g.blocked));
    } else if (this.streaming) {
      parts.push('streaming…');
    } else {
      parts.push(this.boundLabel ? `pdock ${this.boundLabel}` : 'ready');
    }

    this.dotEl.className =
      g && (g.cooldownRemainingMs > 0 || g.blocked) ? 'dot warn' : 'dot on';
    this.statusEl.textContent = parts.join(' · ');
  }

  setBound(bound: boolean, label?: string): void {
    this.bound = bound;
    if (label !== undefined) {
      this.boundLabel = label;
    } else if (!bound) {
      this.boundLabel = '';
    }
    this.renderStatus();
  }

  setSkills(skills: SkillSummary[]): void {
    this.skills = skills;
    if (this.skillMenu.style.display !== 'none') {
      this.renderSkillMenu();
    }
  }

  setBatchActive(active: boolean): void {
    this.cancelBtn.style.display = active ? 'inline-block' : 'none';
  }

  setGuardSummary(g: GuardSummary): void {
    this.lastGuard = g;
    if (g.stopped !== this.stopped) {
      this.stopped = g.stopped;
      this.renderStop();
    }
    this.budgetEl.textContent =
      this.bound && (g.consecutiveAutoTurns > 0 || g.hourlyTurns > 0)
        ? `${g.consecutiveAutoTurns}t · ${g.hourlyTurns}/h`
        : '';
    this.renderStatus();
  }

  setStreamingBadge(active: boolean): void {
    this.streaming = active;
    this.renderStatus();
  }

  showToast(message: string, kind: 'info' | 'ok' | 'err' = 'info', durationMs = 3500): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.className = kind === 'info' ? 'toast' : `toast ${kind}`;
    this.toastEl.style.display = 'block';
    this.toastTimer = setTimeout(() => {
      this.toastEl.style.display = 'none';
      this.toastTimer = null;
    }, durationMs);
  }

  remove(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastEl.remove();
    this.el.remove();
  }
}

function humanReason(reason: string): string {
  switch (reason) {
    case 'HIDDEN_TAB':
      return 'waiting for focus';
    case 'CHALLENGE':
      return 'challenge detected';
    case 'RATE_LIMIT':
      return 'rate limited';
    case 'BUDGET_CONSECUTIVE':
      return 'consecutive budget reached';
    case 'BUDGET_HOURLY':
      return 'hourly budget reached';
    default:
      return reason.toLowerCase().replace(/_/g, ' ');
  }
}
