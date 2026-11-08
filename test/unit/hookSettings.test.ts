import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeHooks } from '../../src/shared/hookSettings';

const CMD = '"node" "C:/Users/x/AppData/Local/claude-review/bin/relay.js"';
const theirs = { type: 'command', command: 'prettier --write' };

test('install preserves unrelated settings and hooks; is idempotent', () => {
  const s = { model: 'opus', permissions: { deny: ['Read(./.env)'] }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [theirs] }] } };
  const once = mergeHooks(s, CMD);
  const twice = mergeHooks(once, CMD);
  assert.deepEqual(once, twice);
  assert.equal(once.model, 'opus');
  assert.deepEqual(once.permissions, s.permissions);
  const post = (once.hooks as Record<string, { hooks: { command: string }[] }[]>).PostToolUse;
  assert.equal(post.length, 2);
  assert.equal(post[0].hooks[0].command, 'prettier --write');
  assert.equal(post[1].hooks[0].command, CMD);
});

test('uninstall removes only our hooks and drops empty block', () => {
  const s = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [theirs] }] } };
  const removed = mergeHooks(mergeHooks(s, CMD), undefined);
  assert.deepEqual(removed, s);
  assert.deepEqual(mergeHooks(mergeHooks({}, CMD), undefined), {});
});
