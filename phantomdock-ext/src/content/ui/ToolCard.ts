// Approval cards for pdock_call blocks: category badge, JSON args or unified
// diff preview (edit_file / write_file), Approve / Reject / Trust-for-session,
// Running state, turn-level status bar, and collapsed completed state.
// Mounted in the fixed scrollable dock above ControlBar so multiple calls in
// one turn never overlap or scroll out of reach.

import type { ToolInfo } from '../../shared/protocol';
import { collapseContext, diffLines, diffStats } from '../../shared/diff';
import type { ParsedCall, ResolvedCall } from '../parser';
import { getShadowRoot, h } from './shadow';

export interface ToolCardCallbacks {
  onApprove: (call: ParsedCall) => void;
  onReject: (call: ParsedCall) => void;
  onTrustSession: (call: ParsedCall) => void;
}

export class ToolCard {
  readonly call: ParsedCall;
  private el: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private disposed = false;
  private actionStarted = false;
  stale = false;

  constructor(
    call: ParsedCall,
    toolInfo: ToolInfo | null,
    private callbacks: ToolCardCallbacks,
    _anchor: HTMLElement | null,
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
        style: 'pointer-events:auto;padding:10px 12px;width:100%;',
      },
      [this.bodyEl],
    );
    root.dock.appendChild(this.el);
  }

  private renderPending(category: string, toolInfo: ToolInfo | null, stale: boolean): void {
    this.bodyEl.replaceChildren();

    const header = h('div', { class: 'row', style: 'margin-bottom:4px;' }, [
      h('span', { class: `badge ${category}`, text: category.toUpperCase() }),
      h('span', {
        class: 'mono',
        style: 'font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;',
        text: this.call.name,
      }),
      h('div', { class: 'grow' }),
      stale ? h('span', { class: 'badge', text: 'STALE' }) : null,
      h('span', { class: 'dim mono', style: 'font-size:10px;', text: this.call.id }),
    ]);
    this.bodyEl.append(header);

    const preview = this.previewEl();
    if (preview) this.bodyEl.append(preview);

    if (toolInfo?.description) {
      this.bodyEl.append(
        h('div', { class: 'dim', style: 'margin-top:4px;', text: toolInfo.description }),
      );
    }

    const approveBtn = h('button', {
      class: 'btn primary',
      text: 'Approve',
      onclick: () => {
        if (this.actionStarted) return;
        this.setRunning();
        this.callbacks.onApprove(this.call);
      },
    });
    const rejectBtn = h('button', {
      class: 'btn',
      text: 'Reject',
      onclick: () => {
        if (this.actionStarted) return;
        this.actionStarted = true;
        this.callbacks.onReject(this.call);
      },
    });
    const trustBtn = h('button', {
      class: 'btn ghost',
      text: 'Trust session',
      title: 'Auto-approve this tool for the rest of the session',
      onclick: () => {
        if (this.actionStarted) return;
        this.setRunning();
        this.callbacks.onTrustSession(this.call);
      },
    });

    const buttons = h('div', { class: 'row', style: 'margin-top:8px;', 'data-actions': '1' }, [
      approveBtn,
      rejectBtn,
      trustBtn,
    ]);
    this.bodyEl.append(buttons);
  }

  /** Transition card into a non-clickable Running state while daemon executes. */
  setRunning(): void {
    if (this.disposed) return;
    this.actionStarted = true;
    const actions = this.bodyEl.querySelector('[data-actions]');
    if (actions) {
      actions.replaceChildren(
        h('span', { class: 'dim mono', text: `Running ${this.call.name}…` }),
      );
    }
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
    this.actionStarted = true;
    const ok = resolved.approved && resolved.result?.status !== 'error';
    const icon = ok ? '✓' : '✗';
    const cls = ok ? 'status-ok' : 'status-err';
    this.bodyEl.replaceChildren(
      h('div', { class: 'row' }, [
        h('span', { class: cls, style: 'font-weight:700;', text: icon }),
        h('span', {
          class: 'mono',
          style: 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
          text: summaryLine(this.call, resolved),
        }),
        h('div', { class: 'grow' }),
        h('button', {
          class: 'btn ghost',
          text: 'Expand',
          onclick: () => this.showResultDetail(resolved),
        }),
        h('button', {
          class: 'btn ghost',
          text: '×',
          title: 'Dismiss card',
          onclick: () => this.remove(),
        }),
      ]),
    );
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
        h('button', {
          class: 'btn ghost',
          text: '×',
          title: 'Dismiss card',
          onclick: () => this.remove(),
        }),
      ]),
      h('pre', { class: 'code', style: 'max-height:260px;', text }),
    );
  }

  setExecutedSummary(line: string): void {
    if (this.disposed) return;
    this.actionStarted = true;
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
    if (this.disposed) return;
    const existing = this.bodyEl.querySelector('[data-statusline]');
    existing?.remove();
    this.bodyEl.append(
      h('div', { class: 'dim', style: 'margin-top:4px;', 'data-statusline': '1', text }),
    );
  }

  remove(): void {
    if (this.disposed) return;
    this.disposed = true;
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
  if (r?.status === 'error') return `${call.name} — ${r.text.slice(0, 80)}`;
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
