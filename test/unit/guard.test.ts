import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkToolCall, DEFAULT_GUARD_CONFIG, globToRegExp, sensitiveMatch } from '../../src/shared/guard';

const cfg = DEFAULT_GUARD_CONFIG;

test('glob conversion', () => {
  assert.ok(globToRegExp('*.pem').test('server.pem'));
  assert.ok(!globToRegExp('*.pem').test('a/server.pem'));
  assert.ok(globToRegExp('**/secrets/**').test('x/secrets/db.txt'));
  assert.ok(globToRegExp('**/secrets/**').test('secrets/db.txt'));
  assert.ok(globToRegExp('id_rsa*').test('id_rsa.pub'));
});

test('sensitive matching with allow list', () => {
  assert.equal(sensitiveMatch('C:\\repo\\.env', cfg), '.env');
  assert.equal(sensitiveMatch('/repo/.env.production', cfg), '.env.*');
  assert.equal(sensitiveMatch('/repo/.env.example', cfg), undefined);
  assert.equal(sensitiveMatch('/home/u/.ssh/id_ed25519.pub', cfg), undefined, '*.pub is allowed');
  assert.equal(sensitiveMatch('/home/u/.ssh/config', cfg), '**/.ssh/**');
  assert.equal(sensitiveMatch('/repo/config/secrets/api.txt', cfg), '**/secrets/**');
  assert.equal(sensitiveMatch('/repo/src/index.ts', cfg), undefined);
  assert.equal(sensitiveMatch('/repo/src/environment.ts', cfg), undefined);
});

test('tool calls', () => {
  assert.ok(checkToolCall('Read', { file_path: '/r/.env' }, cfg));
  assert.ok(checkToolCall('Edit', { file_path: '/r/certs/server.key', old_string: 'a', new_string: 'b' }, cfg));
  assert.ok(checkToolCall('Bash', { command: 'cat .env | head' }, cfg));
  assert.ok(checkToolCall('Bash', { command: 'type "C:\\repo\\prod.pfx"' }, cfg));
  assert.ok(checkToolCall('Bash', { command: 'echo x >.env' }, cfg));
  assert.ok(checkToolCall('Grep', { pattern: 'KEY', path: '/r/.env' }, cfg));
  assert.equal(checkToolCall('Bash', { command: 'npm test' }, cfg), undefined);
  assert.equal(checkToolCall('Read', { file_path: '/r/README.md' }, cfg), undefined);
  assert.equal(checkToolCall('Read', { file_path: '/r/.env' }, { ...cfg, enabled: false }), undefined);
});
