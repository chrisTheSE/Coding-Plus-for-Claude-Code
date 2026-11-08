// Explorer / tab badges for files changed by Claude, plus the status bar item.
import * as vscode from 'vscode';
import { ChangeModel } from '../model/changeModel';
import { hunkStats } from '../model/diff';

export class ClaudeFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private last = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly model: ChangeModel) {
    this.off = model.onDidChange(() => {
      const now = new Set(model.all().map((f) => vscode.Uri.file(f.path).toString()));
      const changed = [...new Set([...this.last, ...now])].map((u) => vscode.Uri.parse(u));
      this.last = now;
      this.emitter.fire(changed);
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const f = this.model.get(uri.fsPath);
    if (!f) return undefined;
    const s = hunkStats(f.hunks);
    return {
      badge: 'C',
      tooltip: `Changed by Claude (+${s.added} −${s.removed}), pending review`,
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      propagate: false,
    };
  }

  dispose(): void {
    this.off();
    this.emitter.dispose();
  }
}

export class ReviewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('claudeReview.status', vscode.StatusBarAlignment.Left, 50);
  private readonly off: () => void;

  constructor(private readonly model: ChangeModel) {
    this.item.name = 'Claude Review';
    this.item.command = 'claudeReview.changes.focus';
    this.off = model.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const t = this.model.totals();
    if (t.files === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(diff) Claude: ${t.files} file${t.files === 1 ? '' : 's'} · +${t.added} −${t.removed}`;
    this.item.tooltip = `${t.hunks} change(s) from Claude awaiting review. Click to open the Changes view.`;
    this.item.show();
  }

  dispose(): void {
    this.off();
    this.item.dispose();
  }
}
