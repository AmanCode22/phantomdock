// Floating control bar: Attach Workspace / Attach Skill / STOP / Cooldown /
// turn-budget status — always accessible inside the closed Shadow DOM.

import type { SkillSummary } from '../../shared/protocol';
import type { GuardSummary } from '../guards-runtime';
import { getShadowRoot, h } from './shadow';

export interface ControlBarCallbacks {
  onAttachWorkspace: () => void;
  onAttachSkill: (name: string) => void;
  onStopToggle: (stopped: boolean) => void;
}

export class ControlBar {
  private el: HTMLDivElement;
  private stopBtn: HTMLButtonElement;
  private statusEl: HTMLSpanElement;
  private budgetEl: HTMLSpanElement;
  private skillMenu: HTMLDivElement;
  private stopped = false;
  private lastGuard: GuardSummary | null = null;

  constructor(
    private callbacks: ControlBarCallbacks,
    private skills: SkillSummary[],
    bound: boolean,
  ) {
    const root = getShadowRoot();
    this.stopBtn = h('button', {
      class: 'btn danger',
      text: 'STOP',
      onclick: () => {
        this.stopped = !this.stopped;
        this.callbacks.onStopToggle(this.stopped);
        this.renderStop();
      },
    });
    this.statusEl = h('span', { class: 'dim', text: bound ? 'ready' : 'not paired' });
    this.budgetEl = h('span', { class: 'dim mono' });
    this.skillMenu = h('div', {
      class: 'panel',
      style: 'position:absolute;bottom:44px;right:0;min-width:260px;padding:8px;display:none;',
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
        style: 'position:relative;display:flex;gap:8px;padding:8px 10px;align-items:center;',
      },
      [
        wsBtn,
        skillBtn,
        this.stopBtn,
        h('div', { class: 'grow' }),
        this.budgetEl,
        this.statusEl,
        this.skillMenu,
      ],
    );
    root.float.appendChild(this.el);
    this.renderStop();
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
        h('div', { class: 'dim', text: 'No skills discovered by pdock.' }),
      );
      return;
    }
    for (const s of this.skills) {
      this.skillMenu.append(
        h(
          'button',
          {
            class: 'btn ghost',
            style: 'display:block;width:100%;text-align:left;margin:2px 0;',
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

  setBound(bound: boolean, cwd?: string): void {
    this.statusEl.textContent = bound ? `pdock: ${cwd ?? ''}` : 'not paired';
  }

  setGuardSummary(g: GuardSummary): void {
    this.lastGuard = g;
    const parts: string[] = [];
    if (g.stopped) parts.push('STOPPED');
    if (g.cooldownRemainingMs > 0) {
      const s = Math.ceil(g.cooldownRemainingMs / 1000);
      parts.push(`cooldown ${Math.floor(s / 60)}m${s % 60}s`);
    }
    if (g.blocked && !g.stopped && g.cooldownRemainingMs <= 0) {
      parts.push(humanReason(g.blocked));
    }
    this.statusEl.textContent = parts.length ? parts.join(' · ') : 'ready';
    this.budgetEl.textContent = `${g.consecutiveAutoTurns} consecutive · ${g.hourlyTurns}/h`;
  }

  setStreamingBadge(active: boolean): void {
    if (active && this.lastGuard && !this.lastGuard.stopped && this.lastGuard.cooldownRemainingMs <= 0) {
      this.statusEl.textContent = 'receiving tool call…';
    }
  }

  remove(): void {
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
