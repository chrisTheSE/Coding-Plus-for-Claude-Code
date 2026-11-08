// Keep / Undo / Diff CodeLens above each hunk, plus a file-level summary lens.
import * as vscode from 'vscode';
import { ChangeModel } from '../model/changeModel';
import { hunkStats } from '../model/diff';

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly off: () => void;

  constructor(private readonly model: ChangeModel) {
    this.off = model.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('claudeReview').get<boolean>('codeLens.enabled', true)) return [];
    if (doc.uri.scheme !== 'file') return [];
    const fc = this.model.get(doc.uri.fsPath);
    if (!fc) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    const s = hunkStats(fc.hunks);
    lenses.push(
      new vscode.CodeLens(top, {
        title: `$(sparkle) Claude changed this file: ${fc.hunks.length} change${fc.hunks.length === 1 ? '' : 's'} (+${s.added} −${s.removed})`,
        command: 'claudeReview.openDiff',
        arguments: [fc.path],
      }),
      new vscode.CodeLens(top, { title: '$(check-all) Keep All', command: 'claudeReview.keepFile', arguments: [fc.path] }),
      new vscode.CodeLens(top, { title: '$(discard) Undo All', command: 'claudeReview.undoFile', arguments: [fc.path] }),
    );
    fc.hunks.forEach((h, i) => {
      const line = Math.min(doc.lineCount - 1, h.newLines.length ? h.newStart : Math.max(0, h.newStart - 1));
      const r = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(r, { title: '$(check) Keep', command: 'claudeReview.keepHunk', arguments: [fc.path, i] }),
        new vscode.CodeLens(r, { title: '$(discard) Undo', command: 'claudeReview.undoHunk', arguments: [fc.path, i] }),
        new vscode.CodeLens(r, { title: `+${h.newLines.length} −${h.oldLines.length}`, command: 'claudeReview.openDiff', arguments: [fc.path] }),
      );
    });
    return lenses;
  }

  dispose(): void {
    this.off();
    this.emitter.dispose();
  }
}
