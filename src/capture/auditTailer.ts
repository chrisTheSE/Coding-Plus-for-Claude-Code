// Tails the local audit log (written by the hook relay) and delivers new
// entries. Uses fs.watch with a polling fallback; no network involved.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { AuditEntry, auditLogSize, readAuditFrom } from '../shared/auditLog';

export class AuditTailer implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private reading = false;
  private pending = false;

  constructor(
    private readonly root: string,
    private readonly state: vscode.Memento,
    private readonly onEntries: (entries: AuditEntry[]) => void | Promise<void>,
  ) {}

  private get offset(): number {
    return this.state.get<number>('claudeReview.auditOffset', -1);
  }

  start(): void {
    if (this.offset < 0) {
      // First run in this workspace: do not replay history from other projects.
      void this.state.update('claudeReview.auditOffset', auditLogSize(this.root));
    }
    try {
      fs.mkdirSync(this.root, { recursive: true });
      this.watcher = fs.watch(this.root, (_e, name) => {
        if (!name || String(name).startsWith('audit.jsonl')) this.poll();
      });
    } catch {
      /* fall back to polling only */
    }
    // Polling safety net (fs.watch can miss events on some filesystems).
    this.timer = setInterval(() => this.poll(), 1500);
    this.poll();
  }

  poll(): void {
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.reading = true;
    void (async () => {
      try {
        do {
          this.pending = false;
          const { entries, offset } = readAuditFrom(this.root, Math.max(0, this.offset));
          if (offset !== this.offset) await this.state.update('claudeReview.auditOffset', offset);
          if (entries.length) await this.onEntries(entries);
        } while (this.pending);
      } catch (e) {
        console.error('[claude-review] audit tail failed', e);
      } finally {
        this.reading = false;
      }
    })();
  }

  dispose(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }
}
