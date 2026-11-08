// Installs / uninstalls the Claude Code hooks that feed this extension.
//
// Hooks are plain `command` hooks that run the bundled relay with Node.js.
// They are merged into a Claude Code settings file without touching any
// other hooks; a one-time backup is written next to the file.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { relayInstallPath } from '../shared/paths';

import { HooksBlock, hooksBlock, isOurs, mergeHooks } from '../shared/hookSettings';

/** Copy the bundled relay to a stable, version-independent location. */
export function installRelayCopy(extensionUri: vscode.Uri, root: string): string {
  const src = path.join(extensionUri.fsPath, 'dist', 'relay.js');
  const dst = relayInstallPath(root);
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  const srcBuf = fs.readFileSync(src);
  let same = false;
  try { same = fs.readFileSync(dst).equals(srcBuf); } catch { /* missing */ }
  if (!same) fs.writeFileSync(dst, srcBuf, { mode: 0o600 });
  return dst;
}

/** Locate a Node.js executable on PATH without spawning a shell. */
export function findNode(): string | undefined {
  const exe = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const e of exe) {
      const p = path.join(dir.replace(/^"|"$/g, ''), e);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* continue */ }
    }
  }
  return undefined;
}

const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;

export function hookCommand(relay: string): string {
  const override = vscode.workspace.getConfiguration('claudeReview').get<string>('hookCommand', '').trim();
  if (override) return override.includes('relay.js') ? override : `${override} ${q(relay)}`;
  const node = findNode();
  if (node) return `${q(node)} ${q(relay)}`;
  // Fallback: run the relay with VS Code's bundled Node runtime.
  return `ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(relay)}`;
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function settingsTargets(): { label: string; detail: string; file: string }[] {
  const out: { label: string; detail: string; file: string }[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== 'file') continue;
    out.push({
      label: `$(folder) This project: ${f.name}`,
      detail: path.join(f.uri.fsPath, '.claude', 'settings.local.json') + '  (personal, not committed)',
      file: path.join(f.uri.fsPath, '.claude', 'settings.local.json'),
    });
  }
  out.push({
    label: '$(account) All projects (user settings)',
    detail: path.join(claudeConfigDir(), 'settings.json'),
    file: path.join(claudeConfigDir(), 'settings.json'),
  });
  return out;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON; fix it before installing hooks (${(e as Error).message})`);
  }
}

export function writeSettings(file: string, command: string | undefined): void {
  const current = readJson(file);
  const next = mergeHooks(current, command);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.claude-review.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function isInstalledIn(file: string): boolean {
  try {
    const s = readJson(file);
    const hooks = (s.hooks ?? {}) as HooksBlock;
    return Object.values(hooks).some((ms) => Array.isArray(ms) && ms.some((m) => (m.hooks ?? []).some(isOurs)));
  } catch {
    return false;
  }
}

export function anyInstalled(): boolean {
  return settingsTargets().some((t) => isInstalledIn(t.file));
}

export async function installHooksInteractive(extensionUri: vscode.Uri, root: string): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Installing Claude Code hooks requires a trusted workspace.');
    return false;
  }
  const relay = installRelayCopy(extensionUri, root);
  const command = hookCommand(relay);
  const pick = await vscode.window.showQuickPick(settingsTargets(), {
    title: 'Install Claude Code hooks',
    placeHolder: 'Where should the hooks be installed?',
  });
  if (!pick) return false;
  const confirm = await vscode.window.showInformationMessage(
    'Install Claude Code hooks?',
    {
      modal: true,
      detail:
        `File: ${pick.file}\n\nCommand: ${command}\n\n` +
        'The hook runs a local script that records Claude\'s tool calls and file snapshots to an audit log on this machine ' +
        `(${root}) and blocks access to sensitive files. It makes no network connections. Other hooks in the file are left untouched; a backup is saved once.`,
    },
    'Install',
  );
  if (confirm !== 'Install') return false;
  writeSettings(pick.file, command);
  if (!findNode() && !vscode.workspace.getConfiguration('claudeReview').get<string>('hookCommand')) {
    void vscode.window.showWarningMessage(
      'Node.js was not found on PATH, so the hook uses VS Code\'s bundled runtime. If Claude Code reports hook errors, install Node.js or set "claudeReview.hookCommand".',
    );
  }
  void vscode.window.showInformationMessage('Claude Code hooks installed. New Claude sessions will be captured (restart running sessions).');
  return true;
}

export async function uninstallHooksInteractive(): Promise<void> {
  const targets = settingsTargets().filter((t) => isInstalledIn(t.file));
  if (!targets.length) {
    void vscode.window.showInformationMessage('No Claude Review hooks found in project or user settings.');
    return;
  }
  const picks = await vscode.window.showQuickPick(targets, { canPickMany: true, title: 'Remove Claude Review hooks from…' });
  if (!picks?.length) return;
  for (const p of picks) writeSettings(p.file, undefined);
  void vscode.window.showInformationMessage(`Removed Claude Review hooks from ${picks.length} file(s).`);
}

export function managedSettingsSnippet(extensionUri: vscode.Uri, root: string): string {
  const relay = installRelayCopy(extensionUri, root);
  return JSON.stringify({ hooks: hooksBlock(hookCommand(relay)) }, null, 2);
}
