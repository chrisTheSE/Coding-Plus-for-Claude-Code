// Content-addressed snapshot store (sha256). Files are stored uncompressed so
// that auditors can inspect them with ordinary tools.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blobDir } from './paths';

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function blobPath(root: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid blob hash: ${hash}`);
  return path.join(blobDir(root), hash.slice(0, 2), hash);
}

/** Store bytes; returns their sha256. Idempotent. */
export function putBlob(root: string, data: Buffer): string {
  const hash = sha256(data);
  const p = blobPath(root, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try {
      fs.renameSync(tmp, p);
    } catch {
      // Another process stored the same blob concurrently.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } else {
    // Touch so retention keeps recently used blobs.
    const now = new Date();
    try { fs.utimesSync(p, now, now); } catch { /* ignore */ }
  }
  return hash;
}

export function getBlob(root: string, hash: string): Buffer | undefined {
  try {
    return fs.readFileSync(blobPath(root, hash));
  } catch {
    return undefined;
  }
}

/**
 * Snapshot a file on disk. Returns null when the file does not exist,
 * undefined when it is too large / unreadable (snapshot skipped).
 */
export function snapshotFile(root: string, file: string): string | null | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
  try {
    return putBlob(root, fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** Delete blobs not modified within `days`, except those in `keep`. Returns count deleted. */
export function pruneBlobs(root: string, days: number, keep: Set<string>): number {
  const cutoff = Date.now() - days * 86_400_000;
  let deleted = 0;
  const dir = blobDir(root);
  let shards: string[] = [];
  try { shards = fs.readdirSync(dir); } catch { return 0; }
  for (const shard of shards) {
    const sd = path.join(dir, shard);
    let files: string[] = [];
    try { files = fs.readdirSync(sd); } catch { continue; }
    for (const f of files) {
      if (keep.has(f)) continue;
      const fp = path.join(sd, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          deleted++;
        }
      } catch { /* ignore */ }
    }
  }
  return deleted;
}
