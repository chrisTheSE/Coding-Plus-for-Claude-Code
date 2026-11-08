// Pure (VS Code-independent) model of files changed by Claude and their
// pending hunks relative to a baseline.
import { diffLines, Hunk, hunkStats, keepHunk as keepHunkText } from './diff';
import { pathKey } from '../shared/paths';

export interface FileChange {
  path: string;
  /** Text before Claude touched the file. null = file did not exist. */
  baseline: string | null;
  /** Current text. null = file does not exist (deleted). */
  current: string | null;
  hunks: Hunk[];
  sessions: string[];
  firstSeen: string;
  /** Where the baseline came from. */
  baselineSource: 'hook' | 'git' | 'unknown';
}

export interface PersistedChange {
  path: string;
  baselineHash: string | null;
  sessions: string[];
  firstSeen: string;
  baselineSource: FileChange['baselineSource'];
}

export class ChangeModel {
  private readonly files = new Map<string, FileChange>();
  private readonly listeners = new Set<() => void>();

  onDidChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }

  get(path: string): FileChange | undefined {
    return this.files.get(pathKey(path));
  }

  has(path: string): boolean {
    return this.files.has(pathKey(path));
  }

  all(): FileChange[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  totals(): { files: number; hunks: number; added: number; removed: number } {
    let hunks = 0, added = 0, removed = 0;
    for (const f of this.files.values()) {
      hunks += f.hunks.length;
      const s = hunkStats(f.hunks);
      added += s.added;
      removed += s.removed;
    }
    return { files: this.files.size, hunks, added, removed };
  }

  /**
   * Start tracking a file with the given baseline. If already tracked, the
   * original baseline is kept (review is always against the first snapshot)
   * and only the session list is updated.
   */
  track(path: string, baseline: string | null, current: string | null, opts: { session?: string; source?: FileChange['baselineSource']; firstSeen?: string } = {}): FileChange | undefined {
    const key = pathKey(path);
    const existing = this.files.get(key);
    if (existing) {
      if (opts.session && !existing.sessions.includes(opts.session)) existing.sessions.push(opts.session);
      return this.update(path, current);
    }
    const fc: FileChange = {
      path,
      baseline,
      current,
      hunks: [],
      sessions: opts.session ? [opts.session] : [],
      firstSeen: opts.firstSeen ?? new Date().toISOString(),
      baselineSource: opts.source ?? 'hook',
    };
    fc.hunks = computeHunks(fc);
    if (isUnchanged(fc)) return undefined;
    this.files.set(key, fc);
    this.fire();
    return fc;
  }

  /** Recompute hunks after the current text changed. Drops the file if it now matches its baseline. */
  update(path: string, current: string | null): FileChange | undefined {
    const key = pathKey(path);
    const fc = this.files.get(key);
    if (!fc) return undefined;
    if (fc.current === current && fc.hunks.length) return fc;
    fc.current = current;
    fc.hunks = computeHunks(fc);
    if (isUnchanged(fc)) {
      this.files.delete(key);
      this.fire();
      return undefined;
    }
    this.fire();
    return fc;
  }

  /** Accept one hunk: fold it into the baseline. */
  keepHunk(path: string, index: number): void {
    const fc = this.get(path);
    if (!fc || !fc.hunks[index]) return;
    fc.baseline = keepHunkText(fc.baseline ?? '', fc.hunks[index]);
    this.recompute(fc);
  }

  /** Accept every change in a file (stop tracking it). */
  keepFile(path: string): void {
    if (this.files.delete(pathKey(path))) this.fire();
  }

  remove(path: string): void {
    this.keepFile(path);
  }

  clear(): void {
    if (this.files.size) {
      this.files.clear();
      this.fire();
    }
  }

  private recompute(fc: FileChange): void {
    fc.hunks = computeHunks(fc);
    if (isUnchanged(fc)) this.files.delete(pathKey(fc.path));
    this.fire();
  }

  /** Find the hunk index containing (or nearest after) a 0-based line in the current text. */
  hunkAtLine(path: string, line: number): number {
    const fc = this.get(path);
    if (!fc) return -1;
    return fc.hunks.findIndex((h) => line >= h.newStart && line < h.newStart + Math.max(1, h.newLines.length));
  }

  serialize(hashOf: (text: string) => string): PersistedChange[] {
    return this.all().map((f) => ({
      path: f.path,
      baselineHash: f.baseline === null ? null : hashOf(f.baseline),
      sessions: f.sessions,
      firstSeen: f.firstSeen,
      baselineSource: f.baselineSource,
    }));
  }
}

function computeHunks(fc: FileChange): Hunk[] {
  return diffLines(fc.baseline ?? '', fc.current ?? '');
}

function isUnchanged(fc: FileChange): boolean {
  // A file created empty by Claude, or deleted when it did not exist, is not a change.
  if (fc.baseline === null && fc.current === null) return true;
  if (fc.hunks.length) return false;
  // Same text, but existence differs (created empty file / deleted empty file).
  return (fc.baseline === null) === (fc.current === null);
}
