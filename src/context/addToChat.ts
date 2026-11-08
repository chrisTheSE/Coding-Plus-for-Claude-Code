// "Add to Claude Chat": deliver @-mentions for files, folders and selections
// to the official Claude Code chat (anthropic.claude-code), or to a Claude CLI
// running in the integrated terminal.
//
// The official extension exposes `claude-vscode.insertAtMention`, which takes
// no arguments and mentions the active editor (+ selection). For files we
// briefly show the file and call it; for folders / multi-select we focus the
// Claude input and paste the @-mentions.
import * as fs from 'node:fs';
import * as vscode from 'vscode';

const CLAUDE_EXT = 'anthropic.claude-code';
const CMD_MENTION = 'claude-vscode.insertAtMention';
const CMD_FOCUS = 'claude-vscode.focus';

type Method = 'auto' | 'mention' | 'paste' | 'terminal';

function method(): Method {
  return vscode.workspace.getConfiguration('claudeReview').get<Method>('addToChat.method', 'auto');
}

/** Format an @-mention the same way the official extension does. */
export function mentionFor(uri: vscode.Uri, range?: { start: number; end: number }): string | undefined {
  let rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (rel.includes('#') || rel.includes('"')) return undefined;
  let isDir = false;
  try { isDir = fs.statSync(uri.fsPath).isDirectory(); } catch { /* ignore */ }
  if (isDir && !rel.endsWith('/')) rel += '/';
  if (!range) return `@${rel}`;
  return range.start === range.end ? `@${rel}#${range.start}` : `@${rel}#${range.start}-${range.end}`;
}

async function officialAvailable(): Promise<boolean> {
  const ext = vscode.extensions.getExtension(CLAUDE_EXT);
  if (!ext) return false;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { return false; }
  }
  const cmds = await vscode.commands.getCommands(true);
  return cmds.includes(CMD_MENTION);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mention a single file via the official command (shows the file briefly). */
async function mentionViaCommand(uri: vscode.Uri, selection?: vscode.Selection): Promise<void> {
  const previous = vscode.window.activeTextEditor;
  const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false, selection });
  if (!selection) editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand(CMD_MENTION);
  if (previous && previous.document.uri.toString() !== uri.toString()) {
    // Restore what the user was looking at; the chat input keeps focus otherwise.
    await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preserveFocus: true, selection: previous.selection });
  }
}

/** Focus the Claude chat input and paste text into it. */
async function pasteIntoChat(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text + ' ');
  // Collapse the active selection so claude-vscode.focus does not add its own mention.
  const ed = vscode.window.activeTextEditor;
  if (ed && !ed.selection.isEmpty) ed.selection = new vscode.Selection(ed.selection.active, ed.selection.active);
  await vscode.commands.executeCommand(CMD_FOCUS);
  await sleep(350);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  void vscode.window.setStatusBarMessage(`$(comment-discussion) Added to Claude chat: ${text}  (if nothing appeared, press Ctrl+V in the chat input)`, 6000);
}

function sendToTerminal(text: string): boolean {
  const term = vscode.window.activeTerminal;
  if (!term) return false;
  term.sendText(text + ' ', false);
  term.show(false);
  return true;
}

export async function addUrisToChat(uris: vscode.Uri[]): Promise<void> {
  const fileUris = uris.filter((u) => u.scheme === 'file');
  if (!fileUris.length) {
    void vscode.window.showWarningMessage('Only files on disk can be added to Claude chat.');
    return;
  }
  const mentions: string[] = [];
  for (const u of fileUris) {
    const m = mentionFor(u);
    if (m) mentions.push(m);
    else void vscode.window.showWarningMessage(`This path can't be @-mentioned (contains # or "): ${u.fsPath}`);
  }
  if (!mentions.length) return;
  const text = mentions.join(' ');
  const m = method();

  if (m === 'terminal') {
    if (!sendToTerminal(text)) void vscode.window.showWarningMessage('No active terminal. Start `claude` in a terminal first.');
    return;
  }
  if (!(await officialAvailable())) {
    if (sendToTerminal(text)) return;
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`Claude Code extension not found. Copied to clipboard: ${text}`);
    return;
  }
  const singleFile = fileUris.length === 1 && !mentions[0].endsWith('/');
  if (m === 'mention' || (m === 'auto' && singleFile)) {
    for (const u of fileUris) {
      if (mentionFor(u)?.endsWith('/')) continue;
      await mentionViaCommand(u);
    }
    if (m === 'mention' && mentions.some((x) => x.endsWith('/'))) await pasteIntoChat(mentions.filter((x) => x.endsWith('/')).join(' '));
    return;
  }
  await pasteIntoChat(text);
}

/** Editor context menu: add the current selection (or file) to chat. */
export async function addSelectionToChat(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  if (method() === 'terminal' || !(await officialAvailable())) {
    const s = ed.selection;
    const m = mentionFor(ed.document.uri, s.isEmpty ? undefined : { start: s.start.line + 1, end: s.end.line + 1 });
    if (m && !sendToTerminal(m)) {
      await vscode.env.clipboard.writeText(m);
      void vscode.window.showInformationMessage(`Copied to clipboard: ${m}`);
    }
    return;
  }
  await vscode.commands.executeCommand(CMD_MENTION);
}

/**
 * Resolve the URIs a context-menu command was invoked on. VS Code passes
 * (clicked, allSelected) for Explorer multi-select, a Uri for editor tabs,
 * or a tree node for our own view.
 */
export function urisFromArgs(arg0: unknown, arg1: unknown): vscode.Uri[] {
  if (Array.isArray(arg1) && arg1.length && arg1[0] instanceof vscode.Uri) return arg1 as vscode.Uri[];
  if (arg0 instanceof vscode.Uri) return [arg0];
  if (arg0 && typeof arg0 === 'object' && 'file' in arg0) {
    const f = (arg0 as { file: { path: string } }).file;
    return [vscode.Uri.file(f.path)];
  }
  if (Array.isArray(arg1)) {
    return arg1.flatMap((n) => (n && typeof n === 'object' && 'file' in n ? [vscode.Uri.file((n as { file: { path: string } }).file.path)] : []));
  }
  const ed = vscode.window.activeTextEditor;
  return ed ? [ed.document.uri] : [];
}
