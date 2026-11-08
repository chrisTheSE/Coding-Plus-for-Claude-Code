// Coding Plus for Claude Code: entry point.
//
// Data flow (all local; this extension makes no network connections):
//   Claude Code --(command hook)--> relay.js --> <dataRoot>/audit.jsonl + blobs/
//   extension --(tails audit.jsonl)--> ChangeModel --> inline diff / CodeLens / tree
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AuditTailer } from './capture/auditTailer';
import {
  anyInstalled,
  installHooksInteractive,
  installRelayCopy,
  managedSettingsSnippet,
  uninstallHooksInteractive,
} from './capture/hookInstaller';
import { addSelectionToChat, addUrisToChat, urisFromArgs } from './context/addToChat';
import { ChangeModel } from './model/changeModel';
import { ReviewService } from './review/reviewService';
import { exportAuditLog, verifyAuditLogCommand } from './safety/auditCommands';
import { ensureDataRoot } from './shared/auditLog';
import { pruneBlobs, sha256 } from './shared/blobStore';
import { GuardConfig, writeGuardConfig } from './shared/guard';
import { dataRoot } from './shared/paths';
import { BASELINE_SCHEME, BaselineProvider, openBaselineDiff } from './ui/baselineProvider';
import { ChangesTreeProvider, TreeNode } from './ui/changesTree';
import { HunkCodeLensProvider } from './ui/codelens';
import { ChatIsolation } from './ui/chatIsolation';
import { ContextMeter } from './ui/contextMeter';
import { InlineDiffDecorations } from './ui/decorations';
import { ClaudeFileDecorations, ReviewStatusBar } from './ui/fileBadges';

export async function activate(context: vscode.ExtensionContext): Promise<{ service: ReviewService; root: string }> {
  const root = dataRoot();
  ensureDataRoot(root);
  syncGuardConfig(root);
  try {
    installRelayCopy(context.extensionUri, root);
  } catch (e) {
    console.error('[claude-review] could not refresh relay copy', e);
  }

  const model = new ChangeModel();
  const service = new ReviewService(model, root, context.workspaceState);
  await service.restore();

  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const tree = new ChangesTreeProvider(model, (uris) => addUrisToChat(uris));
  const treeView = vscode.window.createTreeView<TreeNode>('claudeReview.changes', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const baseline = new BaselineProvider(model);
  const tailer = new AuditTailer(root, context.workspaceState, (entries) => service.handleEntries(entries));

  context.subscriptions.push(
    service,
    tree,
    treeView,
    baseline,
    tailer,
    new InlineDiffDecorations(model, media),
    new ClaudeFileDecorations(model),
    new ReviewStatusBar(model),
    new ContextMeter(),
    new ChatIsolation(),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, baseline),
  );
  const lens = new HunkCodeLensProvider(model);
  context.subscriptions.push(lens, vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens));

  // ----------------------------------------------------------- context keys
  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    const active = !!ed && ed.document.uri.scheme === 'file' && model.has(ed.document.uri.fsPath);
    void vscode.commands.executeCommand('setContext', 'claudeReview.activeFileHasChanges', active);
    void vscode.commands.executeCommand('setContext', 'claudeReview.hasChanges', model.all().length > 0);
    const t = model.totals();
    treeView.badge = t.files ? { value: t.files, tooltip: `${t.files} file(s) changed by Claude` } : undefined;
  };
  const updateHooksContext = () =>
    void vscode.commands.executeCommand('setContext', 'claudeReview.hooksInstalled', anyInstalled() || context.globalState.get('claudeReview.sawHook', false));
  // Tell the user (once per Claude session) that there are changes to review.
  const notifiedSessions = new Set<string>(context.workspaceState.get<string[]>('claudeReview.notifiedSessions', []));
  const notifyNewSessions = () => {
    if (!vscode.workspace.getConfiguration('claudeReview').get<boolean>('notifyOnChanges', true)) return;
    const fresh = [...new Set(model.all().flatMap((f) => f.sessions))].filter((s) => !notifiedSessions.has(s));
    if (!fresh.length) return;
    fresh.forEach((s) => notifiedSessions.add(s));
    void context.workspaceState.update('claudeReview.notifiedSessions', [...notifiedSessions].slice(-50));
    const n = model.all().length;
    void vscode.window
      .showInformationMessage(`Claude changed ${n} file${n === 1 ? '' : 's'}. Changed lines are highlighted in the editor.`, 'Review Changes')
      .then((c) => {
        if (c === 'Review Changes') void vscode.commands.executeCommand('claudeReview.changes.focus');
      });
  };
  const offModel = model.onDidChange(() => {
    updateContext();
    notifyNewSessions();
  });
  context.subscriptions.push(
    { dispose: offModel },
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    service.onHookEvent(() => {
      if (!context.globalState.get('claudeReview.sawHook')) {
        void context.globalState.update('claudeReview.sawHook', true);
        updateHooksContext();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeReview.secretGuard') || e.affectsConfiguration('claudeReview.audit')) syncGuardConfig(root);
    }),
  );
  updateContext();
  updateHooksContext();

  // ----------------------------------------------------------- commands
  const fileArg = (a: unknown): string | undefined => {
    if (typeof a === 'string') return a;
    if (a instanceof vscode.Uri) return a.fsPath;
    if (a && typeof a === 'object' && 'file' in a) return (a as TreeNode).file.path;
    const ed = vscode.window.activeTextEditor;
    return ed?.document.uri.scheme === 'file' ? ed.document.uri.fsPath : undefined;
  };
  const hunkArg = (a: unknown, b: unknown): [string, number] | undefined => {
    if (typeof a === 'string' && typeof b === 'number') return [a, b];
    if (a && typeof a === 'object' && (a as TreeNode).kind === 'hunk') {
      const n = a as Extract<TreeNode, { kind: 'hunk' }>;
      return [n.file.path, n.index];
    }
    return undefined;
  };
  const atCursor = (): [string, number] | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return undefined;
    const file = ed.document.uri.fsPath;
    const idx = model.hunkAtLine(file, ed.selection.active.line);
    if (idx < 0) {
      void vscode.window.setStatusBarMessage('No Claude change at the cursor', 3000);
      return undefined;
    }
    return [file, idx];
  };
  const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('claudeReview.keepHunk', (a, b) => {
    const h = hunkArg(a, b);
    if (h) service.keepHunk(...h);
  });
  reg('claudeReview.undoHunk', async (a, b) => {
    const h = hunkArg(a, b);
    if (h) await service.undoHunk(...h).catch(showError);
  });
  reg('claudeReview.keepHunkAtCursor', () => {
    const h = atCursor();
    if (h) service.keepHunk(...h);
  });
  reg('claudeReview.undoHunkAtCursor', async () => {
    const h = atCursor();
    if (h) await service.undoHunk(...h).catch(showError);
  });
  reg('claudeReview.keepFile', (a) => {
    const f = fileArg(a);
    if (f) service.keepFile(f);
  });
  reg('claudeReview.undoFile', async (a) => {
    const f = fileArg(a);
    if (f) await service.undoFile(f).catch(showError);
  });
  reg('claudeReview.keepAll', () => service.keepAll());
  reg('claudeReview.undoAll', async () => {
    const n = model.all().length;
    const ok = await vscode.window.showWarningMessage(`Undo all Claude changes in ${n} file(s)?`, { modal: true, detail: 'Files Claude created will be moved to the trash.' }, 'Undo All');
    if (ok === 'Undo All') await service.undoAll().catch(showError);
  });
  reg('claudeReview.clearAll', () => service.clearAll());
  reg('claudeReview.openDiff', async (a) => {
    const f = fileArg(a);
    if (f) await openBaselineDiff(f);
  });
  reg('claudeReview.nextHunk', () => navigate(model, 1));
  reg('claudeReview.prevHunk', () => navigate(model, -1));

  reg('claudeReview.addToChat', async (a, b) => addUrisToChat(urisFromArgs(a, b)).catch(showError));
  reg('claudeReview.addSelectionToChat', async () => addSelectionToChat().catch(showError));

  reg('claudeReview.installHooks', async () => {
    try {
      if (await installHooksInteractive(context.extensionUri, root)) updateHooksContext();
    } catch (e) {
      showError(e);
    }
  });
  reg('claudeReview.uninstallHooks', async () => {
    await uninstallHooksInteractive().catch(showError);
    updateHooksContext();
  });
  reg('claudeReview.copyManagedSettingsSnippet', async () => {
    await vscode.env.clipboard.writeText(managedSettingsSnippet(context.extensionUri, root));
    void vscode.window.showInformationMessage('Managed-settings hook snippet copied. See docs/ENTERPRISE.md for how an admin deploys it.');
  });
  reg('claudeReview.verifyAuditLog', () => verifyAuditLogCommand(root));
  reg('claudeReview.exportAuditLog', () => exportAuditLog(root).catch(showError));
  reg('claudeReview.openDataFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(root, 'audit.jsonl'))));

  // ----------------------------------------------------------- start
  tailer.start();
  setTimeout(() => runRetention(root, model), 30_000);

  if (!anyInstalled() && !context.globalState.get('claudeReview.sawHook') && !context.globalState.get('claudeReview.promptedInstall')) {
    void context.globalState.update('claudeReview.promptedInstall', true);
    void vscode.window
      .showInformationMessage('Coding Plus for Claude Code needs Claude Code hooks to capture edits for review.', 'Install Hooks…', 'Later')
      .then((c) => {
        if (c === 'Install Hooks…') void vscode.commands.executeCommand('claudeReview.installHooks');
      });
  }

  return { service, root };
}

export function deactivate(): void {
  /* disposables are cleaned up by VS Code */
}

function syncGuardConfig(root: string): void {
  const c = vscode.workspace.getConfiguration('claudeReview');
  const cfg: GuardConfig = {
    enabled: c.get<boolean>('secretGuard.enabled', true),
    action: c.get<'deny' | 'ask'>('secretGuard.action', 'deny'),
    patterns: c.get<string[]>('secretGuard.patterns', []),
    allowPatterns: c.get<string[]>('secretGuard.allowPatterns', []),
    recordPrompts: c.get<boolean>('audit.recordPrompts', true),
  };
  try {
    writeGuardConfig(root, cfg);
  } catch (e) {
    console.error('[claude-review] could not write guard config', e);
  }
}

function runRetention(root: string, model: ChangeModel): void {
  const days = vscode.workspace.getConfiguration('claudeReview').get<number>('retentionDays', 30);
  const keep = new Set(model.serialize((t) => sha256(Buffer.from(t, 'utf8'))).flatMap((p) => (p.baselineHash ? [p.baselineHash] : [])));
  try {
    pruneBlobs(root, Math.max(1, days), keep);
  } catch (e) {
    console.error('[claude-review] retention failed', e);
  }
}

async function navigate(model: ChangeModel, dir: 1 | -1): Promise<void> {
  const files = model.all().filter((f) => f.current !== null && f.hunks.length);
  if (!files.length) return;
  const stops = files.flatMap((f) => f.hunks.map((h) => ({ path: f.path, line: Math.max(0, h.newLines.length ? h.newStart : h.newStart - 1) })));
  const ed = vscode.window.activeTextEditor;
  const curPath = ed?.document.uri.fsPath ?? '';
  const curLine = ed?.selection.active.line ?? -1;
  const curFileIdx = files.findIndex((f) => f.path.toLowerCase() === curPath.toLowerCase());
  const order = (p: string) => files.findIndex((f) => f.path === p);
  let target;
  if (dir === 1) {
    target = stops.find((s) => order(s.path) > curFileIdx || (order(s.path) === curFileIdx && s.line > curLine)) ?? stops[0];
  } else {
    target = [...stops].reverse().find((s) => (order(s.path) < curFileIdx && curFileIdx >= 0) || (order(s.path) === curFileIdx && s.line < curLine)) ?? stops[stops.length - 1];
  }
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(target.path));
  const pos = new vscode.Position(target.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function showError(e: unknown): void {
  void vscode.window.showErrorMessage(`Claude Review: ${(e as Error)?.message ?? String(e)}`);
}
