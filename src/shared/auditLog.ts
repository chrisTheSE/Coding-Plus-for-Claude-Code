// Append-only, hash-chained audit log (JSON Lines).
//
// Each entry carries `prev` (hash of the previous entry) and `hash`
// = sha256(prev + canonicalJson(entry without hash)). Any edit, deletion or
// reordering of entries breaks the chain and is reported by verifyAuditLog().
//
// Writers (the hook relay processes and the VS Code extension) serialise
// appends through an exclusive lock file.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from './canonicalJson';
import { sha256 } from './blobStore';
import { auditLockPath, auditLogPath } from './paths';

export const GENESIS = '0'.repeat(64);

export type AuditSource = 'hook' | 'extension';

export interface AuditEntryBody {
  /** Schema version. */
  v: 1;
  ts: string;
  src: AuditSource;
  /** Hook event name (PreToolUse, PostToolUse, ...) or extension action (keep, undo, ...). */
  event: string;
  session?: string;
  promptId?: string;
  cwd?: string;
  tool?: string;
  toolUseId?: string;
  /** Absolute file paths touched. */
  files?: string[];
  /** Snapshot hash of the file before the tool ran; null = file did not exist. */
  before?: string | null;
  /** Snapshot hash of the file after the tool ran; null = file does not exist. */
  after?: string | null;
  /** Tool input, with large string values replaced by {sha256,len}. */
  input?: unknown;
  prompt?: string;
  promptSha256?: string;
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  detail?: unknown;
}

export interface AuditEntry extends AuditEntryBody {
  seq: number;
  prev: string;
  hash: string;
}

export function computeHash(prev: string, body: Omit<AuditEntry, 'hash'>): string {
  return sha256(prev + canonicalJson(body));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(root: string, fn: () => T): T {
  const lock = auditLockPath(root);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        // Break stale locks (a writer that crashed).
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch { /* ignore */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for audit log lock');
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

/** Read the last complete line of the log without reading the whole file. */
function readLastEntry(file: string): AuditEntry | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return undefined;
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8').replace(/\n+$/, '');
      const nl = text.lastIndexOf('\n');
      if (nl >= 0 || start === 0) {
        return JSON.parse(text.slice(nl + 1)) as AuditEntry;
      }
      chunk *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function appendAudit(root: string, body: AuditEntryBody): AuditEntry {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = auditLogPath(root);
  return withLock(root, () => {
    const last = readLastEntry(file);
    const prev = last ? last.hash : GENESIS;
    const seq = last ? last.seq + 1 : 1;
    const unhashed = { ...body, seq, prev };
    const entry: AuditEntry = { ...unhashed, hash: computeHash(prev, unhashed) };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return entry;
  });
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** 1-based line number of the first problem. */
  badLine?: number;
  problem?: string;
}

export function verifyAuditLog(root: string): VerifyResult {
  const file = auditLogPath(root);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, entries: 0 }; }
  const lines = text.split('\n');
  let prev = GENESIS;
  let expectedSeq = 1;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (i === lines.length - 1) break;
      return { ok: false, entries: n, badLine: i + 1, problem: 'empty line inside log' };
    }
    let e: AuditEntry;
    try { e = JSON.parse(line) as AuditEntry; } catch {
      return { ok: false, entries: n, badLine: i + 1, problem: 'unparseable JSON' };
    }
    if (e.prev !== prev) return { ok: false, entries: n, badLine: i + 1, problem: 'chain broken (prev hash mismatch)' };
    if (e.seq !== expectedSeq) return { ok: false, entries: n, badLine: i + 1, problem: `sequence gap (expected ${expectedSeq}, got ${e.seq})` };
    const { hash, ...rest } = e;
    if (computeHash(prev, rest) !== hash) return { ok: false, entries: n, badLine: i + 1, problem: 'entry content does not match its hash' };
    prev = hash;
    expectedSeq++;
    n++;
  }
  return { ok: true, entries: n };
}

/**
 * Read complete entries starting at byte `offset`. Returns the entries and the
 * new offset (just past the last complete line).
 */
export function readAuditFrom(root: string, offset: number): { entries: AuditEntry[]; offset: number } {
  const file = auditLogPath(root);
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return { entries: [], offset: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset > size) offset = 0; // log replaced/rotated
    if (offset === size) return { entries: [], offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { entries: [], offset };
    const entries: AuditEntry[] = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line) continue;
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { /* skip corrupt line */ }
    }
    return { entries, offset: offset + lastNl + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

export function auditLogSize(root: string): number {
  try { return fs.statSync(auditLogPath(root)).size; } catch { return 0; }
}

export function ensureDataRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o700 });
}
