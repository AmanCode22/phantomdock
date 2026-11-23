// Minimal unified line diff (LCS) used to preview edit_file / write_file in
// tool cards. Pure functions — unit tested.

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  // Empty-file semantics: '' is no lines, not one empty line.
  if (oldText === '' && newText === '') return [];
  if (oldText === '') return newText.split('\n').map((text) => ({ kind: 'add', text }) as DiffLine);
  if (newText === '') return oldText.split('\n').map((text) => ({ kind: 'del', text }) as DiffLine);
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS table (capped to keep previews cheap).
  const CAP = 2000;
  if (n > CAP || m > CAP) {
    return [
      { kind: 'ctx', text: `(diff too large: ${n} -> ${m} lines)` },
      { kind: 'del', text: `${Math.min(n, 40)} old lines…` },
      { kind: 'add', text: `${Math.min(m, 40)} new lines…` },
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i++] });
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j++] });
  }
  return out;
}

/** Collapse long runs of context lines around changes (unified-diff style). */
export function collapseContext(diff: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((d, idx) => {
    if (d.kind !== 'ctx') {
      for (let k = Math.max(0, idx - context); k <= Math.min(diff.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  const out: DiffLine[] = [];
  let skipping = false;
  diff.forEach((d, idx) => {
    if (keep[idx]) {
      out.push(d);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: 'ctx', text: '⋯' });
      skipping = true;
    }
  });
  return out;
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.kind === 'add') added++;
    else if (d.kind === 'del') removed++;
  }
  return { added, removed };
}
