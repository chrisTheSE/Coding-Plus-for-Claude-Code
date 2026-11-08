import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diffLines, keepHunk, splitLines, undoHunk } from '../../src/model/diff';

function rnd(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

test('splitLines keeps terminators', () => {
  assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n\n'), ['\n', '\n']);
});

test('identical texts produce no hunks', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), []);
});

test('pure insertion, deletion and modification', () => {
  assert.deepEqual(diffLines('a\nc\n', 'a\nb\nc\n'), [{ oldStart: 1, newStart: 1, oldLines: [], newLines: ['b\n'] }]);
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nc\n'), [{ oldStart: 1, newStart: 1, oldLines: ['b\n'], newLines: [] }]);
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nB\nc\n'), [{ oldStart: 1, newStart: 1, oldLines: ['b\n'], newLines: ['B\n'] }]);
});

test('new file and deleted file', () => {
  assert.deepEqual(diffLines('', 'x\ny'), [{ oldStart: 0, newStart: 0, oldLines: [], newLines: ['x\n', 'y'] }]);
  assert.deepEqual(diffLines('x\n', ''), [{ oldStart: 0, newStart: 0, oldLines: ['x\n'], newLines: [] }]);
});

test('CRLF change and missing final newline are detected', () => {
  assert.equal(diffLines('a\r\nb\r\n', 'a\nb\r\n').length, 1);
  assert.equal(diffLines('a\nb', 'a\nb\n').length, 1);
});

test('multiple separated hunks', () => {
  const h = diffLines('1\n2\n3\n4\n5\n6\n', '1\nX\n3\n4\n5\nY\n6\n');
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { oldStart: 1, newStart: 1, oldLines: ['2\n'], newLines: ['X\n'] });
  assert.deepEqual(h[1], { oldStart: 5, newStart: 5, oldLines: [], newLines: ['Y\n'] });
});

test('property: keeping all hunks yields current; undoing all yields baseline (byte-identical)', () => {
  const r = rnd(42);
  const alphabet = ['a\n', 'b\n', 'c\r\n', 'd\n', 'e', '\n', 'foo\n'];
  for (let iter = 0; iter < 400; iter++) {
    const mk = () => Array.from({ length: Math.floor(r() * 25) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    const a = mk();
    const b = mk();
    const hunks = diffLines(a, b);
    let base = a;
    for (const h of [...hunks].reverse()) base = keepHunk(base, h);
    assert.equal(base, b, `keep all failed for ${JSON.stringify([a, b])}`);
    let cur = b;
    for (const h of [...hunks].reverse()) cur = undoHunk(cur, h);
    assert.equal(cur, a, `undo all failed for ${JSON.stringify([a, b])}`);
  }
});

test('large diff falls back to a single hunk without blowing up', () => {
  const a = Array.from({ length: 20000 }, (_, i) => `a${i}\n`).join('');
  const b = Array.from({ length: 20000 }, (_, i) => `b${i}\n`).join('');
  const t = Date.now();
  const h = diffLines(a, b);
  assert.ok(h.length >= 1);
  assert.ok(Date.now() - t < 5000);
  let cur = b;
  for (const x of [...h].reverse()) cur = undoHunk(cur, x);
  assert.equal(cur, a);
});
