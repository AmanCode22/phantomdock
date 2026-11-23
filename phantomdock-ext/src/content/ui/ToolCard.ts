// Approval cards for pdock_call blocks: category badge, JSON args or unified
// diff preview (edit_file / write_file), Approve / Reject / Trust-for-session,
// turn-level status bar, and collapsed completed state.

import type { ToolInfo } from '../../shared/protocol';
import { collapseContext, diffLines, diffStats } from '../../shared/diff';
import type { ParsedCall, ResolvedCall } from '../parser';
import { anchorOver, getShadowRoot, h } from './shadow';

export interface ToolCardCallbacks {
  onApprove: (call: ParsedCall) => void;
  onReject: (call: ParsedCall) => void;
  onTrustSession: (call: ParsedCall) => void;
}

export class ToolCard {
  readonly call: ParsedCall;
  private el: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private anchorCleanup: (() => void) | null = null;
  private disposed = false;
  stale = false;

  constructor(
    call: ParsedCall,
    toolInfo: ToolInfo | null,
    private callbacks: ToolCardCallbacks,
    anchor: HTMLElement | null,
    stale = false,
  ) {
    this.call = call;
    this.stale = stale;
    const root = getShadowRoot();
    const category = toolInfo?.category ?? guessCategory(call.name);

    this.bodyEl = h('div', {});
    this.renderPending(category, toolInfo, stale);

    this.el = h(
      'div',
      {
        class: 'panel',
        style: 'position:absolute;pointer-events:auto;padding:10px 12px;margin:6px 0;width:420px;',
      },
      [this.bodyEl],
    );
    root.stage.appendChild(this.el);
    if (anchor) {
      this.anchorCleanup = anchorOver(this.el, anchor, 'below');
    }
  }

  private renderPending(category: string, toolInfo: ToolInfo | null, stale: boolean): void {
    this.bodyEl.replaceChildren();

    const header = h('div', { class: 'row', style: 'margin-bottom:4px;' }, [
      h('span', { class: `badge ${category}`, text: category.toUpperCase() }),
      h('span', {
        class: 'mono',
        style: 'font-weight:600;font-size:12px;',
        text: this.call.name,
      }),
      h('div', { class: 'grow' }),
      stale ? h('span', { class: 'badge', text: 'STALE — previous session' }) : null,
    ]);
    this.bodyEl.append(header);

    const preview = this.previewEl();
    if (preview) this.bodyEl.append(preview);

    if (toolInfo?.description) {
      this.bodyEl.append(
        h('div', { class: 'dim', style: 'margin-top:4px;', text: toolInfo.description }),
      );
    }

    const buttons = h('div', { class: 'row', style: 'margin-top:8px;' }, [
      h('button', {
        class: 'btn primary',
        text: 'Approve',
        onclick: () => this.callbacks.onApprove(this.call),
      }),
      h('button', {
        class: 'btn',
        text: 'Reject',
        onclick: () => this.callbacks.onReject(this.call),
      }),
      h('button', {
        class: 'btn ghost',
        text: 'Auto-approve this session',
        title: 'Trust this tool for the rest of the session',
        onclick: () => this.callbacks.onTrustSession(this.call),
      }),
    ]);
    this.bodyEl.append(buttons);
  }

  private previewEl(): HTMLElement | null {
    const { name, args } = this.call;
    if (
      name === 'edit_file' &&
      typeof args.path === 'string' &&
      typeof args.old_str === 'string' &&
      typeof args.new_str === 'string'
    ) {
      const d = collapseContext(diffLines(String(args.old_str), String(args.new_str)), 3);
      const stats = diffStats(d);
      const code = h('pre', { class: 'code' });
      for (const line of d) {
        const span = h('div', {
          class: line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : '',
          text: (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') + line.text,
        });
        code.append(span);
      }
      return h('div', {}, [
        h('div', {
          class: 'mono dim',
          style: 'margin-top:6px;',
          text: `${args.path} (-${stats.removed} +${stats.added})`,
        }),
        code,
      ]);
    }
    if (name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
      const content = String(args.content);
      const head = content.split('\n').slice(0, 30).join('\n');
      return h('div', {}, [
        h('div', {
          class: 'mono dim',
          style: 'margin-top:6px;',
          text: `${args.path} — new file (${content.length} chars)`,
        }),
        h('pre', {
          class: 'code',
          text: head + (content.split('\n').length > 30 ? '\n…' : ''),
        }),
      ]);
    }
    const json = JSON.stringify(args, null, 2);
    if (json === '{}') return null;
    return h('pre', { class: 'code', style: 'max-height:140px;', text: json });
  }

  /** Collapse to a 1-line summary once resolved. */
  setResolved(resolved: ResolvedCall): void {
    if (this.disposed) return;
    const ok = resolved.approved;
    const icon = ok ? '✓' : '✗';
    const cls = ok ? 'status-ok' : 'status-err';
    this.bodyEl.replaceChildren(
      h('div', { class: 'row' }, [
        h('span', { class: cls, style: 'font-weight:700;', text: icon }),
        h('span', {
          class: 'mono',
          style: 'font-size:12px;',
          text: summaryLine(this.call, resolved),
        }),
        h('div', { class: 'grow' }),
        h('button', {
          class: 'btn ghost',
          text: 'Expand',
          onclick: () => {
            this.showResultDetail(resolved);
          },
        }),
      ]),
    );
    this.el.style.pointerEvents = 'auto';
  }

  private showResultDetail(resolved: ResolvedCall): void {
    const text = resolved.result?.text ?? 'Rejected by user.';
    this.bodyEl.replaceChildren(
      h('div', { class: 'row' }, [
        h('span', {
          class: 'mono',
          style: 'font-weight:600;font-size:12px;',
          text: this.call.name,
        }),
        h('div', { class: 'grow' }),
        h('button', {
          class: 'btn ghost',
          text: 'Collapse',
          onclick: () => this.setResolved(resolved),
        }),
      ]),
      h('pre', { class: 'code', style: 'max-height:280px;', text }),
    );
  }

  /** Mark as executed during history hydration (never re-runs). */
  setExecutedSummary(line: string): void {
    if (this.disposed) return;
    this.bodyEl.replaceChildren(
      h('div', { class: 'row' }, [
        h('span', { class: 'status-ok', style: 'font-weight:700;', text: '✓' }),
        h('span', { class: 'mono', style: 'font-size:12px;', text: line }),
        h('div', { class: 'grow' }),
        h('span', { class: 'badge', text: 'EXECUTED' }),
      ]),
    );
  }

  setStatusLine(text: string): void {
    const existing = this.bodyEl.querySelector('[data-statusline]');
    existing?.remove();
    this.bodyEl.append(
      h('div', { class: 'dim', style: 'margin-top:4px;', 'data-statusline': '1', text }),
    );
  }

  remove(): void {
    this.disposed = true;
    this.anchorCleanup?.();
    this.el.remove();
  }
}

function guessCategory(name: string): string {
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'run_shell') return 'shell';
  if (name === 'activate_skill' || name === 'read_skill_resource') return 'skill';
  return 'fs';
}

function summaryLine(call: ParsedCall, resolved: ResolvedCall): string {
  const r = resolved.result;
  if (!resolved.approved) return `${call.name} — rejected`;
  if (!r) return `${call.name}`;
  if (r.status === 'upload_ready' && r.delivery?.mode === 'upload') {
    return `activate_skill → ${r.delivery.filename} attached`;
  }
  if (r.status === 'offloaded' && r.delivery?.mode === 'offload') {
    return `${call.name} → offloaded ${r.delivery.total_chars} chars`;
  }
  const firstLine = r.text.split('\n').find((l) => l.trim()) ?? '';
  return `${call.name} — ${firstLine.slice(0, 60)}`;
}
