// Connects audit events from Claude Code hooks to the ChangeModel, applies
// Keep / Undo to documents, persists pending reviews, and records reviewer
// decisions in the audit log.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeModel, FileChange, PersistedChange } from '../model/changeModel';
import { Hunk, undoHunk } from '../model/diff';
import { appendAudit, AuditEntry } from '../shared/auditLog';
import { getBlob, putBlob } from '../shared/blobStore';
import { isWithin, pathKey, toNativePath } from '../shared/paths';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const STATE_KEY = 'claudeReview.pendingChanges';

export class ReviewService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Baselines captured at PreToolUse, waiting for the matching PostToolUse. */
  private readonly pendingBaselines = new Map<string, { baseline: string | null; session?: string }>();
  /** Timestamp of the latest PreToolUse for a shell tool, per session. */
  private readonly shellStarted = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  /** Paths whose document we are editing ourselves (ignore echo events). */
  private readonly selfEditing = new Set<string>();
  sawHookEvent = false;
  private readonly hookEventEmitter = new vscode.EventEmitter<AuditEntry>();
  readonly onHookEvent = this.hookEventEmitter.event;

  constructor(
    readonly model: ChangeModel,
    private readonly root: string,
    private readonly state: vscode.Memento,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChanged(e.document)),
      this.hookEventEmitter,
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const refresh = (uri: vscode.Uri) => {
      if (this.model.has(uri.fsPath)) this.scheduleRefresh(uri.fsPath, 200);
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    this.disposables.push(watcher);
    this.model.onDidChange(() => this.schedulePersist());
  }

  // ---------------------------------------------------------------- restore

  async restore(): Promise<void> {
    const saved = this.state.get<PersistedChange[]>(STATE_KEY, []);
    for (const p of saved) {
      // v0.1.0 could record git-sourced entries with a missing baseline in repos
      // without commits; those are untrustworthy (Undo would delete the file).
      if (p.baselineSource === 'git' && p.baselineHash === null) continue;
      let baseline: string | null = null;
      if (p.baselineHash) {
        const buf = getBlob(this.root, p.baselineHash);
        if (!buf) continue; // snapshot pruned; cannot review any more
        baseline = buf.toString('utf8');
        putBlob(this.root, buf); // touch for retention
      }
      this.model.track(p.path, baseline, readCurrent(p.path), { source: p.baselineSource, firstSeen: p.firstSeen });
      const fc = this.model.get(p.path);
      if (fc) fc.sessions = [...p.sessions];
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = this.model.serialize((text) => putBlob(this.root, Buffer.from(text, 'utf8')));
      void this.state.update(STATE_KEY, data);
    }, 300);
  }

  // ---------------------------------------------------------------- events

  inWorkspace(file: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file' && isWithin(f.uri.fsPath, file));
  }

  async handleEntries(entries: AuditEntry[]): Promise<void> {
    for (const e of entries) {
      if (e.src !== 'hook') continue;
      const relevant = (e.files ?? []).some((f) => this.inWorkspace(toNativePath(f))) || (e.cwd && this.inWorkspace(toNativePath(e.cwd)));
      if (!relevant) continue;
      this.sawHookEvent = true;
      this.hookEventEmitter.fire(e);
      try {
        await this.handleEntry(e);
      } catch (err) {
        console.error('[claude-review] failed to handle audit entry', e.seq, err);
      }
    }
  }

  private async handleEntry(e: AuditEntry): Promise<void> {
    const tool = e.tool ?? '';
    if (e.event === 'PreToolUse' && EDIT_TOOLS.has(tool) && e.decision === undefined) {
      const file = e.files?.[0] ? toNativePath(e.files[0]) : undefined;
      if (!file || !this.inWorkspace(file) || e.before === undefined) return;
      if (this.model.has(file) || this.pendingBaselines.has(pathKey(file))) return;
      let baseline: string | null = null;
      if (e.before !== null) {
        const buf = getBlob(this.root, e.before);
        if (!buf || isBinary(buf)) return;
        baseline = buf.toString('utf8');
      }
      this.pendingBaselines.set(pathKey(file), { baseline, session: e.session });
      return;
    }
    if (e.event === 'PostToolUse' && EDIT_TOOLS.has(tool)) {
      const file = e.files?.[0] ? toNativePath(e.files[0]) : undefined;
      if (!file || !this.inWorkspace(file)) return;
      const key = pathKey(file);
      const pending = this.pendingBaselines.get(key);
      this.pendingBaselines.delete(key);
      const current = this.currentFromEntry(file, e);
      if (this.model.has(file)) {
        this.model.track(file, null, current, { session: e.session });
      } else if (pending) {
        this.model.track(file, pending.baseline, current, { session: pending.session, source: 'hook' });
      } else {
        // Hooks were installed mid-edit or PreToolUse was missed: fall back to git HEAD.
        const head = await gitShowHead(file);
        if (head !== undefined) this.model.track(file, head, current, { session: e.session, source: 'git' });
      }
      return;
    }
    if (SHELL_TOOLS.has(tool) && e.event === 'PreToolUse') {
      this.shellStarted.set(e.session ?? '', Date.parse(e.ts) || Date.now());
      return;
    }
    if (SHELL_TOOLS.has(tool) && e.event === 'PostToolUse') {
      if (vscode.workspace.getConfiguration('claudeReview').get<boolean>('trackBashEdits', true)) {
        const since = this.shellStarted.get(e.session ?? '') ?? Date.parse(e.ts) - 60_000;
        await this.detectShellEdits(since, e.session);
      }
    }
  }

  private currentFromEntry(file: string, e: AuditEntry): string | null {
    // Prefer the snapshot the relay took right after the tool ran.
    if (typeof e.after === 'string') {
      const buf = getBlob(this.root, e.after);
      if (buf && !isBinary(buf)) {
        // If the document is open with unsaved user edits, those win.
        const doc = findOpenDocument(file);
        return doc && doc.isDirty ? doc.getText() : buf.toString('utf8');
      }
    }
    if (e.after === null) return null;
    return readCurrent(file);
  }

  /** Find files modified by a shell command (git repos only) and track them against HEAD. */
  private async detectShellEdits(sinceMs: number, session?: string): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const out = await run('git', ['-C', folder.uri.fsPath, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (out === undefined) continue;
      const parts = out.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        const status = rec.slice(0, 2);
        const rel = rec.slice(3);
        if (status[0] === 'R' || status[0] === 'C') i++; // skip rename source
        const file = path.join(folder.uri.fsPath, rel);
        if (this.model.has(file)) continue;
        // Deletions carry no timestamp, so we cannot tell whether the command
        // caused them; they are left to the regular SCM view.
        if (status.includes('D')) continue;
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtime < sinceMs - 1000) continue;
        let head: string | null | undefined;
        if (status === '??') {
          // Untracked: only "new" if it was created by this command; otherwise we
          // have no trustworthy baseline and must not offer Undo (it would delete it).
          head = createdSince(file, sinceMs) ? null : undefined;
        } else {
          head = await gitShowHead(file);
        }
        if (head === undefined) continue;
        const current = readCurrent(file);
        if (current !== null && current.includes('\0')) continue;
        this.model.track(file, head, current, { session, source: 'git' });
      }
    }
  }

  // ---------------------------------------------------------------- doc sync

  private onDocChanged(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || !this.model.has(doc.uri.fsPath)) return;
    this.scheduleRefresh(doc.uri.fsPath, 120);
  }

  private scheduleRefresh(file: string, ms: number): void {
    const key = pathKey(file);
    const t = this.docTimers.get(key);
    if (t) clearTimeout(t);
    this.docTimers.set(key, setTimeout(() => {
      this.docTimers.delete(key);
      if (this.selfEditing.has(key)) return;
      this.model.update(file, readCurrent(file));
    }, ms));
  }

  // ---------------------------------------------------------------- actions

  keepHunk(file: string, index: number): void {
    const fc = this.model.get(file);
    const h = fc?.hunks[index];
    if (!fc || !h) return;
    this.model.keepHunk(file, index);
    this.audit('keep-hunk', file, hunkDetail(h));
  }

  async undoHunk(file: string, index: number): Promise<void> {
    const fc = this.model.get(file);
    const h = fc?.hunks[index];
    if (!fc || !h) return;
    if (fc.current === null) {
      // Deleted file: undoing any hunk restores the whole file.
      return this.undoFile(file);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const start = new vscode.Position(h.newStart, 0);
    const endLine = h.newStart + h.newLines.length;
    const end = endLine >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(endLine, 0);
    const replacement = h.oldLines.join('');
    const expected = undoHunk(fc.current, h);
    await this.applyAndSave(doc, (edit) => edit.replace(doc.uri, new vscode.Range(start, end), replacement));
    this.model.update(file, readCurrent(file) ?? expected);
    this.audit('undo-hunk', file, hunkDetail(h));
  }

  keepFile(file: string): void {
    const fc = this.model.get(file);
    if (!fc) return;
    this.model.keepFile(file);
    this.audit('keep-file', file, { hunks: fc.hunks.length });
  }

  async undoFile(file: string): Promise<void> {
    const fc = this.model.get(file);
    if (!fc) return;
    const uri = vscode.Uri.file(file);
    if (fc.baseline === null) {
      // Claude created this file: undo = delete (to trash where supported).
      const doc = findOpenDocument(file);
      if (doc?.isDirty) await doc.save();
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } else if (fc.current === null || !fs.existsSync(file)) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(fc.baseline, 'utf8'));
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      await this.applyAndSave(doc, (edit) => edit.replace(uri, full, fc.baseline as string));
      // Normalise exact bytes (EOL handling in TextDocument may differ from the snapshot).
      if (readCurrent(file) !== fc.baseline && !findOpenDocument(file)?.isDirty) {
        fs.writeFileSync(file, fc.baseline, 'utf8');
      }
    }
    this.model.remove(file);
    this.audit('undo-file', file, { hunks: fc.hunks.length, deletedCreatedFile: fc.baseline === null });
  }

  keepAll(): void {
    const files = this.model.all();
    this.model.clear();
    this.audit('keep-all', undefined, { files: files.map((f) => f.path) });
  }

  async undoAll(): Promise<void> {
    const files = this.model.all();
    for (const f of files) await this.undoFile(f.path);
  }

  clearAll(): void {
    const files = this.model.all();
    this.model.clear();
    this.audit('stop-tracking', undefined, { files: files.map((f) => f.path) });
  }

  private async applyAndSave(doc: vscode.TextDocument, build: (e: vscode.WorkspaceEdit) => void): Promise<void> {
    const key = pathKey(doc.uri.fsPath);
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    build(edit);
    this.selfEditing.add(key);
    try {
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error(`could not edit ${doc.uri.fsPath}`);
      if (!wasDirty) await doc.save();
    } finally {
      this.selfEditing.delete(key);
    }
  }

  private audit(event: string, file: string | undefined, detail: unknown): void {
    try {
      appendAudit(this.root, { v: 1, ts: new Date().toISOString(), src: 'extension', event, files: file ? [file] : undefined, detail });
    } catch (e) {
      console.error('[claude-review] audit append failed', e);
    }
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const t of this.docTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

// ------------------------------------------------------------------ helpers

function hunkDetail(h: Hunk) {
  return { line: h.newStart + 1, added: h.newLines.length, removed: h.oldLines.length };
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function findOpenDocument(file: string): vscode.TextDocument | undefined {
  const key = pathKey(file);
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key);
}

/** Current text of a file: open document (incl. unsaved edits) or disk. null if missing. */
export function readCurrent(file: string): string | null {
  const doc = findOpenDocument(file);
  if (doc && doc.isDirty) return doc.getText();
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return doc ? doc.getText() : null;
  }
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/**
 * Content of the file at git HEAD.
 * - string: the committed content
 * - null: the repo has commits but this file is not in HEAD
 * - undefined: unknown (not a git repo, no commits yet, or git error) — callers
 *   must NOT treat this as "new file", or Undo would delete a pre-existing file.
 */
export async function gitShowHead(file: string): Promise<string | null | undefined> {
  const dir = path.dirname(file);
  const top = (await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']))?.trim();
  if (!top) return undefined;
  if ((await run('git', ['-C', top, 'rev-parse', '--verify', '--quiet', 'HEAD'])) === undefined) return undefined; // no commits yet
  const rel = path.relative(top, file).replace(/\\/g, '/');
  const listed = await run('git', ['-C', top, 'ls-tree', '--name-only', 'HEAD', '--', rel]);
  if (listed === undefined) return undefined;
  if (!listed.trim()) return null;
  return run('git', ['-C', top, 'show', `HEAD:${rel}`]);
}

/** True only if the file was created at or after `sinceMs` (so it did not exist before). */
function createdSince(file: string, sinceMs: number): boolean {
  try {
    const st = fs.statSync(file);
    // A command can only create a file after it started; allow only clock rounding.
    return st.birthtimeMs > 0 && st.birthtimeMs >= sinceMs - 20;
  } catch {
    return false;
  }
}

export type { FileChange };
