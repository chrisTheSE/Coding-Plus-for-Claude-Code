// "Changes" view: every file Claude changed, with its hunks. Supports drag
// (out, as file URIs, e.g. into the Claude chat input) and drop (in, from the
// Explorer, which adds the dropped files to Claude chat).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeModel, FileChange } from '../model/changeModel';
import { Hunk, hunkStats } from '../model/diff';

export type TreeNode = { kind: 'file'; file: FileChange } | { kind: 'hunk'; file: FileChange; hunk: Hunk; index: number };

const URI_LIST = 'text/uri-list';

export class ChangesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly dragMimeTypes = [URI_LIST];
  readonly dropMimeTypes = [URI_LIST, 'application/vnd.code.tree.workbench.explorer.fileView'];
  private readonly off: () => void;

  constructor(private readonly model: ChangeModel, private readonly onDropUris: (uris: vscode.Uri[]) => Promise<void>) {
    this.off = model.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.model.all().map((file) => ({ kind: 'file', file }));
    if (node.kind === 'file') {
      const fresh = this.model.get(node.file.path);
      return (fresh?.hunks ?? []).map((hunk, index) => ({ kind: 'hunk', file: fresh!, hunk, index }));
    }
    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node.kind === 'hunk' ? { kind: 'file', file: node.file } : undefined;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const uri = vscode.Uri.file(node.file.path);
    if (node.kind === 'file') {
      const f = node.file;
      const s = hunkStats(f.hunks);
      const item = new vscode.TreeItem(uri, f.hunks.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `file:${f.path}`;
      item.contextValue = 'file';
      const rel = vscode.workspace.asRelativePath(path.dirname(f.path), false);
      const tag = f.baseline === null ? 'new · ' : f.current === null ? 'deleted · ' : '';
      item.description = `${tag}+${s.added} −${s.removed}${rel && rel !== path.dirname(f.path) && rel !== '.' ? ` · ${rel}` : ''}`;
      item.tooltip = new vscode.MarkdownString(
        `**${vscode.workspace.asRelativePath(f.path, false)}**\n\n` +
          `${f.hunks.length} change(s), +${s.added} −${s.removed}\n\n` +
          `First changed: ${new Date(f.firstSeen).toLocaleString()}\n\n` +
          `Baseline: ${f.baselineSource === 'git' ? 'git HEAD (edited via shell command)' : 'snapshot taken before Claude edited'}\n\n` +
          (f.sessions.length ? `Session(s): ${f.sessions.map((x) => x.slice(0, 8)).join(', ')}` : ''),
      );
      item.command = f.current === null
        ? { command: 'claudeReview.openDiff', title: 'Open Diff', arguments: [f.path] }
        : { command: 'vscode.open', title: 'Open', arguments: [uri] };
      return item;
    }
    const h = node.hunk;
    const first = h.newStart + 1;
    const last = h.newStart + Math.max(1, h.newLines.length);
    const label = h.newLines.length === 0 ? `Removed after line ${h.newStart}` : first === last ? `Line ${first}` : `Lines ${first}–${last}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `hunk:${node.file.path}:${node.index}:${h.newStart}:${h.newLines.length}:${h.oldLines.length}`;
    item.contextValue = 'hunk';
    item.description = `+${h.newLines.length} −${h.oldLines.length}`;
    const preview = (h.newLines.find((l) => l.trim()) ?? h.oldLines.find((l) => l.trim()) ?? '').trim();
    item.tooltip = preview;
    item.iconPath = new vscode.ThemeIcon(h.oldLines.length && h.newLines.length ? 'diff-modified' : h.newLines.length ? 'diff-added' : 'diff-removed');
    const line = Math.max(0, h.newStart - (h.newLines.length ? 0 : 1));
    item.command = {
      command: 'vscode.open',
      title: 'Go to change',
      arguments: [vscode.Uri.file(node.file.path), { selection: new vscode.Range(line, 0, line, 0) } satisfies vscode.TextDocumentShowOptions],
    };
    return item;
  }

  // ------------------------------------------------------------- drag & drop

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const uris = [...new Set(source.map((n) => vscode.Uri.file(n.file.path).toString()))];
    data.set(URI_LIST, new vscode.DataTransferItem(uris.join('\r\n')));
  }

  async handleDrop(_target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(URI_LIST);
    if (!item) return;
    const text = await item.asString();
    const uris = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .map((s) => vscode.Uri.parse(s));
    if (uris.length) await this.onDropUris(uris);
  }

  dispose(): void {
    this.off();
    this.emitter.dispose();
  }
}
