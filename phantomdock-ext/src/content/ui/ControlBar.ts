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
  private skillSearch: HTMLInputElement;
  private skillResults: HTMLDivElement;
  private skillBtn: HTMLButtonElement;
  private workspaceBtn: HTMLButtonElement;
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
    this.skillSearch = h('input', {
      type: 'search',
      class: 'skill-search',
      placeholder: 'Find a skill…',
      'aria-label': 'Find a skill',
      oninput: () => this.renderSkillMenu(),
    });
    this.skillResults = h('div', { class: 'skill-results' });
    this.skillMenu = h('div', {
      class: 'panel skill-menu',
      id: 'pdock-skill-picker',
      hidden: true,
      onkeydown: (event) => {
        if ((event as KeyboardEvent).key === 'Escape') {
          event.stopPropagation();
          this.toggleSkills(false, true);
        }
      },
    }, [this.skillSearch, this.skillResults]);
    this.toastEl = h('div', {
      class: 'toast',
      style: 'display:none;pointer-events:auto;',
    });

    this.skillBtn = h('button', {
      class: 'btn',
      text: 'Skills',
      'aria-expanded': 'false',
      'aria-controls': 'pdock-skill-picker',
      onclick: () => this.toggleSkills(this.skillMenu.hidden, true),
    });
    this.workspaceBtn = h('button', {
      class: 'btn primary',
      text: 'Insert context',
      onclick: () => this.callbacks.onAttachWorkspace(),
    });

    this.el = h(
      'div',
      {
        class: 'panel dock-controls',
        role: 'group',
        'aria-label': 'PhantomDock chat controls',
      },
      [
        this.dotEl,
        this.workspaceBtn,
        this.skillBtn,
        this.cancelBtn,
        this.stopBtn,
        this.budgetEl,
        this.statusEl,
        this.skillMenu,
      ],
    );
    root.float.append(this.toastEl, this.el);
    this.setBound(bound);
    this.renderStop();
    this.renderStatus();
  }

  private renderStop(): void {
    this.stopBtn.textContent = this.stopped ? 'RESUME' : 'STOP';
    this.stopBtn.classList.toggle('danger', !this.stopped);
    this.stopBtn.classList.toggle('primary', this.stopped);
  }

  private toggleSkills(open: boolean, focus = false): void {
    this.skillMenu.hidden = !open;
    this.skillBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.skillSearch.value = '';
      this.renderSkillMenu();
      if (focus) this.skillSearch.focus();
    } else if (focus) {
      this.skillBtn.focus();
    }
  }

  private renderSkillMenu(): void {
    const query = this.skillSearch.value.trim().toLowerCase();
    const matches = this.skills.filter((skill) =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(query),
    );
    this.skillResults.replaceChildren();
    if (!matches.length) {
      this.skillResults.append(h('div', {
        class: 'dim',
        text: this.skills.length ? 'No matching skills.' : 'No skills in this workspace.',
      }));
      return;
    }
    for (const s of matches) {
      this.skillResults.append(
        h(
          'button',
          {
            class: 'btn ghost',
            style: 'display:block;width:100%;text-align:left;margin:2px 0;white-space:normal;',
            onclick: () => {
              this.toggleSkills(false);
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
    this.workspaceBtn.disabled = !bound;
    this.skillBtn.disabled = !bound;
    if (!bound) this.toggleSkills(false);
    if (label !== undefined) {
      this.boundLabel = label;
    } else if (!bound) {
      this.boundLabel = '';
    }
    this.renderStatus();
  }

  setSkills(skills: SkillSummary[]): void {
    this.skills = skills;
    if (!this.skillMenu.hidden) {
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
