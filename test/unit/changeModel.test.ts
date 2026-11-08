import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChangeModel } from '../../src/model/changeModel';

test('track, keep hunk, auto-remove when fully kept', () => {
  const m = new ChangeModel();
  let fired = 0;
  m.onDidChange(() => fired++);
  m.track('/p/a.txt', '1\n2\n3\n', '1\nX\n3\nY\n', { session: 's1' });
  assert.equal(m.get('/p/a.txt')!.hunks.length, 2);
  m.keepHunk('/p/a.txt', 0);
  assert.equal(m.get('/p/a.txt')!.hunks.length, 1);
  assert.equal(m.get('/p/a.txt')!.baseline, '1\nX\n3\n');
  m.keepHunk('/p/a.txt', 0);
  assert.equal(m.get('/p/a.txt'), undefined);
  assert.ok(fired >= 3);
});

test('re-tracking keeps the original baseline and adds sessions', () => {
  const m = new ChangeModel();
  m.track('/p/a.txt', 'orig\n', 'v1\n', { session: 's1' });
  m.track('/p/a.txt', 'v1\n', 'v2\n', { session: 's2' });
  const fc = m.get('/p/a.txt')!;
  assert.equal(fc.baseline, 'orig\n');
  assert.deepEqual(fc.sessions, ['s1', 's2']);
  assert.deepEqual(fc.hunks[0].newLines, ['v2\n']);
});

test('update back to baseline drops the file', () => {
  const m = new ChangeModel();
  m.track('/p/a.txt', 'a\n', 'b\n');
  m.update('/p/a.txt', 'a\n');
  assert.equal(m.all().length, 0);
});

test('new file and deleted file are tracked', () => {
  const m = new ChangeModel();
  m.track('/p/new.txt', null, 'hello');
  m.track('/p/gone.txt', 'bye\n', null);
  m.track('/p/empty.txt', null, '');
  assert.equal(m.all().length, 3);
  assert.equal(m.get('/p/empty.txt')!.hunks.length, 0);
  assert.equal(m.track('/p/nothing.txt', null, null), undefined);
});

test('hunkAtLine', () => {
  const m = new ChangeModel();
  m.track('/p/a.txt', '1\n2\n3\n4\n', '1\nA\nB\n3\n');
  assert.equal(m.hunkAtLine('/p/a.txt', 1), 0);
  assert.equal(m.hunkAtLine('/p/a.txt', 2), 0);
  assert.equal(m.hunkAtLine('/p/a.txt', 0), -1);
});
