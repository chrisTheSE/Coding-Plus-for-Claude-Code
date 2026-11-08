import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handle } from '../../relay/relay';
import { readAuditFrom, verifyAuditLog } from '../../src/shared/auditLog';
import { getBlob } from '../../src/shared/blobStore';
import { writeGuardConfig, DEFAULT_GUARD_CONFIG } from '../../src/shared/guard';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'crc-relay-')); }

test('pre/post edit snapshots before and after content', () => {
  const root = tmp();
  const proj = tmp();
  const file = path.join(proj, 'a.txt');
  fs.writeFileSync(file, 'old\n');
  handle({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'old', new_string: 'new' }, tool_use_id: 't1', cwd: proj }, root);
  fs.writeFileSync(file, 'new\n');
  handle({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 't1', cwd: proj }, root);
  const { entries } = readAuditFrom(root, 0);
  assert.equal(entries.length, 2);
  assert.equal(getBlob(root, entries[0].before as string)!.toString(), 'old\n');
  assert.equal(getBlob(root, entries[1].after as string)!.toString(), 'new\n');
  assert.ok(verifyAuditLog(root).ok);
});

test('write to a new file records before = null', () => {
  const root = tmp();
  const file = path.join(tmp(), 'new.txt');
  handle({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, root);
  assert.equal(readAuditFrom(root, 0).entries[0].before, null);
});

test('secret guard denies and logs; large inputs are hashed', () => {
  const root = tmp();
  const out = handle({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/.env' } }, root);
  assert.equal(JSON.parse(out.stdout!).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(readAuditFrom(root, 0).entries[0].decision, 'deny');

  const big = 'x'.repeat(5000);
  handle({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(tmp(), 'b.txt'), content: big } }, root);
  const e2 = readAuditFrom(root, 0).entries[1];
  assert.equal((e2.input as { content: { len: number } }).content.len, 5000);
});

test('ask mode and prompt recording toggle', () => {
  const root = tmp();
  writeGuardConfig(root, { ...DEFAULT_GUARD_CONFIG, action: 'ask', recordPrompts: false });
  const out = handle({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/id_rsa' } }, root);
  assert.equal(JSON.parse(out.stdout!).hookSpecificOutput.permissionDecision, 'ask');
  handle({ hook_event_name: 'UserPromptSubmit', prompt: 'secret plan' }, root);
  const e = readAuditFrom(root, 0).entries[1];
  assert.equal(e.prompt, undefined);
  assert.equal(typeof e.promptSha256, 'string');
});
