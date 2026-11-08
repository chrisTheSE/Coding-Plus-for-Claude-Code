// Integration tests: run inside a real VS Code instance. Simulates Claude Code
// hook events by invoking the relay's handler (exactly what the hook runs),
// then checks the review model, inline UI commands and Keep/Undo behaviour.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { handle } from '../../../relay/relay';
import type { ReviewService } from '../../../src/review/reviewService';
import { verifyAuditLog } from '../../../src/shared/auditLog';

const EXT_ID = 'christhese.coding-plus-for-claude-code';
const ws = process.env.CRC_TEST_WORKSPACE as string;

let service: ReviewService;
let root: string;

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Simulate Claude editing a file through hooks: Pre snapshot, write, Post snapshot. */
function claudeWrites(file: string, content: string, tool = 'Write'): void {
  const payload = { session_id: 'test-session', cwd: ws, tool_name: tool, tool_input: { file_path: file }, tool_use_id: `t${Date.now()}` };
  handle({ ...payload, hook_event_name: 'PreToolUse' }, root);
  fs.writeFileSync(file, content);
  handle({ ...payload, hook_event_name: 'PostToolUse' }, root);
}

suite('Coding Plus for Claude Code', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension present');
    const api = (await ext.activate()) as { service: ReviewService; root: string };
    service = api.service;
    root = api.root;
    assert.equal(root, process.env.CLAUDE_REVIEW_HOME);
  });

  test('edit captured via hooks shows hunks; undo hunk restores bytes exactly', async () => {
    const file = path.join(ws, 'a.ts');
    const original = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
    fs.writeFileSync(file, original);
    claudeWrites(file, 'const a = 1;\r\nconst b = 42;\r\nconst c = 3;\r\nconst d = 4;\r\n', 'Edit');
    await waitFor(() => service.model.get(file)?.hunks.length === 2, 'two hunks');

    await vscode.window.showTextDocument(vscode.Uri.file(file));
    const fc = service.model.get(file)!;
    assert.equal(fc.baselineSource, 'hook');

    await vscode.commands.executeCommand('claudeReview.undoHunk', file, 1);
    await waitFor(() => service.model.get(file)?.hunks.length === 1, 'one hunk left');
    await vscode.commands.executeCommand('claudeReview.undoHunk', file, 0);
    await waitFor(() => !service.model.has(file), 'file no longer tracked');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  test('keep hunk folds change into baseline; keep file stops tracking', async () => {
    const file = path.join(ws, 'b.txt');
    fs.writeFileSync(file, '1\n2\n3\n4\n5\n');
    claudeWrites(file, '1\nTWO\n3\n4\nFIVE\n');
    await waitFor(() => service.model.get(file)?.hunks.length === 2, 'two hunks');
    await vscode.commands.executeCommand('claudeReview.keepHunk', file, 0);
    assert.equal(service.model.get(file)!.hunks.length, 1);
    assert.equal(service.model.get(file)!.baseline, '1\nTWO\n3\n4\n5\n');
    await vscode.commands.executeCommand('claudeReview.keepFile', file);
    assert.equal(service.model.has(file), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '1\nTWO\n3\n4\nFIVE\n');
  });

  test('file created by Claude: undo deletes it', async () => {
    const file = path.join(ws, 'new-file.md');
    claudeWrites(file, '# hello\n');
    await waitFor(() => service.model.get(file)?.baseline === null, 'new file tracked');
    await vscode.commands.executeCommand('claudeReview.undoFile', file);
    await waitFor(() => !fs.existsSync(file), 'file deleted');
    assert.equal(service.model.has(file), false);
  });

  test('user edits after Claude are reflected; reverting manually clears the review', async () => {
    const file = path.join(ws, 'c.txt');
    fs.writeFileSync(file, 'x\n');
    claudeWrites(file, 'y\n');
    await waitFor(() => service.model.has(file), 'tracked');
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(file));
    await ed.edit((e) => e.replace(new vscode.Range(0, 0, 1, 0), 'x\n'));
    await waitFor(() => !service.model.has(file), 'cleared after manual revert');
    await ed.document.save();
  });

  test('events outside the workspace are ignored', async () => {
    const outside = path.join(path.dirname(ws), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'a\n');
    const payload = { session_id: 's', cwd: path.dirname(outside), tool_name: 'Write', tool_input: { file_path: outside } };
    handle({ ...payload, hook_event_name: 'PreToolUse' }, root);
    fs.writeFileSync(outside, 'b\n');
    handle({ ...payload, hook_event_name: 'PostToolUse' }, root);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(service.model.has(outside), false);
    fs.unlinkSync(outside);
  });

  test('next/prev navigation and diff command work', async () => {
    const file = path.join(ws, 'd.txt');
    fs.writeFileSync(file, 'a\nb\nc\nd\ne\nf\n');
    claudeWrites(file, 'a\nB\nc\nd\ne\nF\n');
    await waitFor(() => service.model.get(file)?.hunks.length === 2, 'two hunks');
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(file));
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('claudeReview.nextHunk');
    assert.equal(vscode.window.activeTextEditor!.selection.active.line, 1);
    await vscode.commands.executeCommand('claudeReview.nextHunk');
    assert.equal(vscode.window.activeTextEditor!.selection.active.line, 5);
    await vscode.commands.executeCommand('claudeReview.openDiff', file);
    await vscode.commands.executeCommand('claudeReview.keepAll');
    assert.equal(service.model.all().length, 0);
  });

  test('shell edits in a git repo with no commits are NOT tracked as new files (Undo would delete them)', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', ws]);
    const file = path.join(ws, 'existing.txt');
    fs.writeFileSync(file, 'before\n');
    const fsTimes = new Date(Date.now() - 60_000);
    fs.utimesSync(file, fsTimes, fsTimes);
    await new Promise((r) => setTimeout(r, 300));
    const payload = { session_id: 'bash-session', cwd: ws, tool_name: 'Bash', tool_input: { command: 'sed -i s/before/after/ existing.txt' } };
    handle({ ...payload, hook_event_name: 'PreToolUse' }, root);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(file, 'after\n');
    handle({ ...payload, hook_event_name: 'PostToolUse' }, root);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(service.model.has(file), false, 'must not track without a trustworthy baseline');
    fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true });
  });

  test('reviewer decisions are appended to a valid audit chain', () => {
    const r = verifyAuditLog(root);
    assert.ok(r.ok, `audit chain broken: ${r.problem}`);
    const text = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8');
    assert.match(text, /"event":"undo-hunk"/);
    assert.match(text, /"event":"keep-file"/);
  });
});
