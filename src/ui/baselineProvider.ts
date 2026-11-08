// Serves the pre-Claude baseline of a file under the `claude-baseline:` scheme
// so it can be shown in VS Code's side-by-side diff editor.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeModel } from '../model/changeModel';

export const BASELINE_SCHEME = 'claude-baseline';

export class BaselineProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly model: ChangeModel) {
    this.off = model.onDidChange(() => {
      for (const u of this.open) this.emitter.fire(vscode.Uri.parse(u));
    });
  }

  static uriFor(file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(file).path, query: 'baseline' });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.open.add(uri.toString());
    const file = vscode.Uri.from({ scheme: 'file', path: uri.path }).fsPath;
    return this.model.get(file)?.baseline ?? '';
  }

  dispose(): void {
    this.off();
    this.emitter.dispose();
  }
}

export async function openBaselineDiff(file: string): Promise<void> {
  const left = BaselineProvider.uriFor(file);
  const right = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (before Claude ↔ now)`, { preview: true });
}
