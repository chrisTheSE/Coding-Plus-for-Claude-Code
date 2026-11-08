// Line diff (Myers O(ND)) with no external dependencies.
//
// Lines keep their terminators ("\n" or "\r\n") so that applying/reverting
// hunks reproduces files byte-for-byte, including CRLF and missing final newline.

export interface Hunk {
  /** 0-based index of the first affected line in the old (baseline) text. */
  oldStart: number;
  /** 0-based index of the first affected line in the new (current) text. */
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Maximum edit distance explored before falling back to one coarse hunk. */
const MAX_D = 3000;

type Op = 0 | 1 | 2; // 0 = equal, 1 = delete (old), 2 = insert (new)

function myers(a: number[], b: number[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_D) return undefined;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m, a, b);
      }
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number, a: number[], b: number[]): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const vd = trace[d]; // covers k in [-d-1, d+1], index = k + d + 1
    const get = (k: number) => vd[k + d + 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(0); x--; y--; }
    if (x === prevX) { ops.push(2); y--; } else { ops.push(1); x--; }
  }
  while (x > 0 && y > 0) { ops.push(0); x--; y--; }
  void a; void b;
  return ops.reverse();
}

export function diffLines(oldText: string, newText: string): Hunk[] {
  return diffLineArrays(splitLines(oldText), splitLines(newText));
}

export function diffLineArrays(a: string[], b: string[]): Hunk[] {
  // Trim common prefix / suffix (cheap and keeps Myers small).
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];

  // Intern lines as integers for fast comparison.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) { id = ids.size; ids.set(s, id); }
    return id;
  };
  const ai = am.map(intern);
  const bi = bm.map(intern);

  const ops = myers(ai, bi);
  if (!ops) {
    return [{ oldStart: pre, newStart: pre, oldLines: am, newLines: bm }];
  }

  const hunks: Hunk[] = [];
  let x = 0;
  let y = 0;
  let cur: Hunk | undefined;
  for (const op of ops) {
    if (op === 0) {
      if (cur) { hunks.push(cur); cur = undefined; }
      x++; y++;
    } else {
      if (!cur) cur = { oldStart: pre + x, newStart: pre + y, oldLines: [], newLines: [] };
      if (op === 1) { cur.oldLines.push(am[x]); x++; } else { cur.newLines.push(bm[y]); y++; }
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** Baseline after accepting ("keeping") one hunk. */
export function keepHunk(baseline: string, hunk: Hunk): string {
  const lines = splitLines(baseline);
  lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
  return lines.join('');
}

/** Current text after reverting ("undoing") one hunk. */
export function undoHunk(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  lines.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines);
  return lines.join('');
}

export function hunkStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) { added += h.newLines.length; removed += h.oldLines.length; }
  return { added, removed };
}
