// TurnBatch: tracks every pdock_call in a single assistant turn. Once all
// cards resolve (approve/reject), fires one combined reply — per spec §0.4.

import type { ToolResultPayload } from '../shared/protocol';
import type { ParsedCall, ResolvedCall } from './parser';

interface Entry {
  call: ParsedCall;
  approved: boolean | null;
  result: ToolResultPayload | null;
}

export class TurnBatch {
  private entries: Map<string, Entry> = new Map();
  private fired = false;

  constructor(
    calls: ParsedCall[],
    private onAllResolved: (resolved: ResolvedCall[]) => void,
  ) {
    for (const call of calls) {
      this.entries.set(call.id, { call, approved: null, result: null });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  resolvedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.approved !== null) n++;
    return n;
  }

  statusLine(): string {
    const total = this.entries.size;
    return `${this.resolvedCount()}/${total} calls resolved — waiting to batch reply`;
  }

  isResolved(call: ParsedCall): boolean {
    const e = this.entries.get(call.id);
    return e !== undefined && e.approved !== null;
  }

  settle(
    call: ParsedCall,
    approved: boolean,
    result: ToolResultPayload | null,
  ): ResolvedCall[] | null {
    const e = this.entries.get(call.id);
    if (!e || e.approved !== null) return null;
    e.approved = approved;
    e.result = result;
    if (this.allSettled() && !this.fired) {
      this.fired = true;
      const resolved = [...this.entries.values()].map((x) => ({
        call: x.call,
        approved: x.approved === true,
        result: x.result,
      }));
      this.onAllResolved(resolved);
      return resolved;
    }
    return null;
  }

  private allSettled(): boolean {
    for (const e of this.entries.values()) if (e.approved === null) return false;
    return true;
  }
}
