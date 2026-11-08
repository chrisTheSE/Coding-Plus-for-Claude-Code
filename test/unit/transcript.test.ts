import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { contextWindowFor, encodeProjectDir, newestTranscript, projectDirsFor, readUsage, usageFromText } from '../../src/shared/transcript';

const asst = (o: object) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: 't', message: { model: 'claude-opus-5-5', usage: o } });

test('encodes project dirs like Claude Code', () => {
  assert.equal(encodeProjectDir('c:\\Users\\Jane Doe\\Documents\\my-project'), 'c--Users-Jane-Doe-Documents-my-project');
  assert.equal(encodeProjectDir('/home/me/my.repo'), '-home-me-my-repo');
});

test('uses the last main-thread assistant usage; skips sidechains and synthetic', () => {
  const text = [
    asst({ input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'x', usage: { input_tokens: 999999 } } }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    '',
  ].join('\n');
  const u = usageFromText(text, '/x/s1.jsonl')!;
  assert.equal(u.tokens, 116);
  assert.equal(u.cacheRead, 100);
  assert.equal(u.model, 'claude-opus-5-5');
  assert.equal(usageFromText('{"type":"user"}\n'), undefined);
});

test('context window heuristics', () => {
  assert.equal(contextWindowFor('claude-sonnet-5-5', 50_000), 200_000);
  assert.equal(contextWindowFor('claude-sonnet-5-5[1m]', 50_000), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5-5', 245_000), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5-5', 10, 500_000), 500_000);
});

test('finds the newest transcript and reads usage from a large file tail', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-cfg-'));
  const ws = 'C:\\Work\\My Repo';
  const dir = path.join(cfg, 'projects', encodeProjectDir(ws).toUpperCase());
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const old = path.join(dir, 'old.jsonl');
  const cur = path.join(dir, 'cur.jsonl');
  fs.writeFileSync(old, asst({ input_tokens: 1 }) + '\n');
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } });
  fs.writeFileSync(cur, asst({ input_tokens: 7, output_tokens: 3 }) + '\n' + Array(600).fill(filler).join('\n') + '\n');
  fs.utimesSync(old, new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(dir, 'sub', 'agent.jsonl'), asst({ input_tokens: 5 }));
  const dirs = projectDirsFor(cfg, ws);
  assert.equal(dirs.length, 1);
  const newest = newestTranscript(dirs)!;
  assert.equal(path.basename(newest.file), 'cur.jsonl');
  assert.equal(readUsage(newest.file)!.tokens, 10);
});
