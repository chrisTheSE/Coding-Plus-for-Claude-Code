import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAudit, readAuditFrom, verifyAuditLog } from '../../src/shared/auditLog';
import { auditLogPath } from '../../src/shared/paths';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'crc-audit-')); }

test('append and verify a chain', () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) appendAudit(root, { v: 1, ts: new Date().toISOString(), src: 'hook', event: 'PreToolUse', tool: 'Edit', files: [`/f${i}`] });
  assert.deepEqual(verifyAuditLog(root), { ok: true, entries: 5 });
  const { entries, offset } = readAuditFrom(root, 0);
  assert.equal(entries.length, 5);
  assert.equal(entries[4].seq, 5);
  assert.equal(readAuditFrom(root, offset).entries.length, 0);
});

test('tampering is detected', () => {
  const root = tmp();
  for (let i = 0; i < 3; i++) appendAudit(root, { v: 1, ts: 't', src: 'hook', event: 'E', files: [`/f${i}`] });
  const file = auditLogPath(root);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('/f1', '/evil');
  fs.writeFileSync(file, lines.join('\n'));
  const r = verifyAuditLog(root);
  assert.equal(r.ok, false);
  assert.equal(r.badLine, 2);
});

test('deleting an entry is detected', () => {
  const root = tmp();
  for (let i = 0; i < 3; i++) appendAudit(root, { v: 1, ts: 't', src: 'hook', event: 'E' });
  const file = auditLogPath(root);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(verifyAuditLog(root).ok, false);
});

test('partial trailing line is not consumed by reader', () => {
  const root = tmp();
  appendAudit(root, { v: 1, ts: 't', src: 'hook', event: 'E' });
  fs.appendFileSync(auditLogPath(root), '{"partial":');
  const { entries, offset } = readAuditFrom(root, 0);
  assert.equal(entries.length, 1);
  assert.ok(offset < fs.statSync(auditLogPath(root)).size);
});
