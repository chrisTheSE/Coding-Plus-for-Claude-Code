// Copilot-style inline diff: green background for lines Claude added or
// changed, a red marker with ghost text for removed lines, and hovers that
// show the original code.
import * as vscode from 'vscode';
import { ChangeModel } from '../model/changeModel';
import { Hunk } from '../model/diff';

const MAX_HOVER_LINES = 40;

export class InlineDiffDecorations implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: ChangeModel, media: vscode.Uri) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      gutterIconPath: vscode.Uri.joinPath(media, 'gutter-added.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: vscode.Uri.joinPath(media, 'gutter-removed.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      this.added,
      this.removed,
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeReview.inlineDiff')) this.refreshAll();
      }),
    );
    const off = model.onDidChange(() => this.refreshAll());
    this.disposables.push({ dispose: off });
    this.refreshAll();
  }

  refreshAll(): void {
    for (const ed of vscode.window.visibleTextEditors) this.refresh(ed);
  }

  private refresh(editor: vscode.TextEditor): void {
    const enabled = vscode.workspace.getConfiguration('claudeReview').get<boolean>('inlineDiff.enabled', true);
    const fc = editor.document.uri.scheme === 'file' ? this.model.get(editor.document.uri.fsPath) : undefined;
    if (!enabled || !fc) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
      return;
    }
    const lineCount = editor.document.lineCount;
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    fc.hunks.forEach((h, i) => {
      const hover = hunkHover(h, i, fc.path, editor.document.languageId);
      for (let l = h.newStart; l < h.newStart + h.newLines.length && l < lineCount; l++) {
        added.push({ range: new vscode.Range(l, 0, l, 0), hoverMessage: h.oldLines.length ? hover : undefined });
      }
      if (h.oldLines.length) {
        // Anchor the "removed" marker on the line just above where text was removed
        // (pure deletion) or on the first replacement line (modification).
        const anchor = Math.min(lineCount - 1, h.newLines.length ? h.newStart : Math.max(0, h.newStart - 1));
        const first = h.oldLines.find((l) => l.trim()) ?? h.oldLines[0];
        const preview = first.replace(/\r?\n$/, '').trim();
        const label = `  ⊖ ${h.oldLines.length} line${h.oldLines.length === 1 ? '' : 's'} removed: ${truncate(preview, 60)}`;
        removed.push({
          range: new vscode.Range(editor.document.lineAt(anchor).range.end, editor.document.lineAt(anchor).range.end),
          hoverMessage: hover,
          renderOptions: {
            after: {
              contentText: label,
              color: new vscode.ThemeColor('editorError.foreground'),
              fontStyle: 'italic',
              textDecoration: 'none; opacity: 0.75',
            },
          },
        });
      }
    });
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removed, removed);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function hunkHover(h: Hunk, index: number, file: string, languageId: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeReview.keepHunk', 'claudeReview.undoHunk', 'claudeReview.openDiff'] };
  const args = encodeURIComponent(JSON.stringify([file, index]));
  md.appendMarkdown(`**Claude change** · +${h.newLines.length} −${h.oldLines.length} · `);
  md.appendMarkdown(`[$(check) Keep](command:claudeReview.keepHunk?${args}) · `);
  md.appendMarkdown(`[$(discard) Undo](command:claudeReview.undoHunk?${args}) · `);
  md.appendMarkdown(`[$(diff) Diff](command:claudeReview.openDiff?${encodeURIComponent(JSON.stringify([file]))})\n\n`);
  if (h.oldLines.length) {
    md.appendMarkdown('Removed:\n');
    const shown = h.oldLines.slice(0, MAX_HOVER_LINES).map((l) => l.replace(/\r?\n$/, '')).join('\n');
    md.appendCodeblock(shown + (h.oldLines.length > MAX_HOVER_LINES ? `\n… ${h.oldLines.length - MAX_HOVER_LINES} more` : ''), languageId);
  }
  return md;
}
