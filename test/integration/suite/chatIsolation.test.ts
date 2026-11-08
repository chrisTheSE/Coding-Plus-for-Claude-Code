// Layout tests: the Claude chat (simulated by a webview with the official
// view type) must stay in its own group on the far right, files must never
// open in or to the right of it, and no extra file groups should appear.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const ws = process.env.CRC_TEST_WORKSPACE as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(900);

function file(name: string): vscode.Uri {
  const p = path.join(ws, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, `${name}\n`);
  return vscode.Uri.file(p);
}

const isChat = (t: vscode.Tab) => t.input instanceof vscode.TabInputWebview;
const groups = () => [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);
const layout = () => groups().map((g) => `[${g.tabs.map((t) => t.label).join(', ')}]`).join(' ');

function assertLayout(expectFileGroups = 1): void {
  const gs = groups();
  const l = layout();
  const last = gs[gs.length - 1];
  assert.ok(last.tabs.some(isChat), `Claude chat must be the rightmost group: ${l}`);
  for (const g of gs) {
    if (g.tabs.some(isChat)) assert.ok(g.tabs.every(isChat), `no files in the chat group: ${l}`);
  }
  const fileGroups = gs.filter((g) => !g.tabs.some(isChat) && g.tabs.length);
  assert.equal(fileGroups.length, expectFileGroups, `expected ${expectFileGroups} file group(s): ${l}`);
}

async function focusChat(panel: vscode.WebviewPanel): Promise<void> {
  panel.reveal(panel.viewColumn, false);
  await sleep(400);
}

suite('Claude chat stays pinned right', () => {
  let panel: vscode.WebviewPanel;

  setup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(300);
  });

  teardown(async () => {
    panel?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('auto-lock setting registered', () => {
    const cfg = vscode.workspace.getConfiguration('workbench.editor').get<Record<string, boolean>>('autoLockGroups') ?? {};
    assert.equal(cfg['mainThreadWebview-claudeVSCodePanel'], true);
  });

  test('file opened while chat is focused goes to the existing file group on the left', async () => {
    await vscode.window.showTextDocument(file('a.txt'), { viewColumn: vscode.ViewColumn.One });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.Two, {});
    await settle();
    await focusChat(panel);
    await vscode.commands.executeCommand('vscode.open', file('b.txt'));
    await settle();
    assertLayout(1);
  });

  test('chat alone: opening files creates ONE file group on the left, never on the right', async () => {
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.One, {});
    await settle();
    await focusChat(panel);
    await vscode.commands.executeCommand('vscode.open', file('c.txt'));
    await settle();
    assertLayout(1);
    await focusChat(panel);
    await vscode.commands.executeCommand('vscode.open', file('d.txt'));
    await settle();
    assertLayout(1);
  });

  test('file opened explicitly into the chat column is moved to the file group', async () => {
    await vscode.window.showTextDocument(file('e.txt'), { viewColumn: vscode.ViewColumn.One });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.Two, {});
    await settle();
    await vscode.window.showTextDocument(file('f.txt'), { viewColumn: panel.viewColumn });
    await settle();
    assertLayout(1);
  });

  test('"open to the side" while chat is focused does not end up right of the chat', async () => {
    await vscode.window.showTextDocument(file('g.txt'), { viewColumn: vscode.ViewColumn.One });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.Two, {});
    await settle();
    await focusChat(panel);
    await vscode.window.showTextDocument(file('h.txt'), { viewColumn: vscode.ViewColumn.Beside });
    await settle();
    assertLayout(1);
  });

  test('tab behaviour in the file group is VS Code default: pinned files accumulate, previews replace each other', async () => {
    await vscode.window.showTextDocument(file('p1.txt'), { viewColumn: vscode.ViewColumn.One, preview: false });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', { viewColumn: vscode.ViewColumn.Two, preserveFocus: true }, {});
    await settle();
    await vscode.window.showTextDocument(file('p2.txt'), { viewColumn: vscode.ViewColumn.One, preview: false });
    await settle();
    // Explorer single-click = preview; a second single-click replaces the first preview (VS Code default).
    await vscode.commands.executeCommand('vscode.open', file('v1.txt'), { preview: true });
    await vscode.commands.executeCommand('vscode.open', file('v2.txt'), { preview: true });
    await settle();
    const fileGroup = groups().find((g) => !g.tabs.some(isChat))!;
    const labels = fileGroup.tabs.map((t) => t.label);
    assert.deepEqual(labels, ['p1.txt', 'p2.txt', 'v2.txt'], `layout: ${layout()}`);
    assertLayout(1);
  });

  test('files opened (pinned) while the chat is focused accumulate as tabs in the file group', async () => {
    await vscode.window.showTextDocument(file('q1.txt'), { viewColumn: vscode.ViewColumn.One, preview: false });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.Two, {});
    await settle();
    for (const n of ['q2.txt', 'q3.txt']) {
      await focusChat(panel);
      await vscode.commands.executeCommand('vscode.open', file(n), { preview: false });
      await settle();
    }
    const fileGroup = groups().find((g) => !g.tabs.some(isChat))!;
    assert.deepEqual(fileGroup.tabs.map((t) => t.label), ['q1.txt', 'q2.txt', 'q3.txt'], `layout: ${layout()}`);
    assertLayout(1);
  });

  test('a split the user makes from a file group is preserved', async () => {
    await vscode.window.showTextDocument(file('i.txt'), { viewColumn: vscode.ViewColumn.One });
    panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code', vscode.ViewColumn.Two, {});
    await settle();
    // Focus the file, then split it (Ctrl+\): a deliberate second file group.
    await vscode.window.showTextDocument(file('i.txt'), { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    await settle();
    assertLayout(2);
  });
});
