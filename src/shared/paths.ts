// Local data locations and path helpers. Shared by the hook relay and the extension.
// Everything this project stores lives under dataRoot() on the local machine.
import * as os from 'node:os';
import * as path from 'node:path';

export const APP_DIR = 'claude-review';

/** Root folder for all local data (audit log, snapshots, guard config, relay copy). */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_REVIEW_HOME) return path.resolve(env.CLAUDE_REVIEW_HOME);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR);
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), APP_DIR);
}

export const auditLogPath = (root: string) => path.join(root, 'audit.jsonl');
export const auditLockPath = (root: string) => path.join(root, 'audit.lock');
export const blobDir = (root: string) => path.join(root, 'blobs');
export const guardConfigPath = (root: string) => path.join(root, 'guard-config.json');
export const relayInstallPath = (root: string) => path.join(root, 'bin', 'relay.js');

/**
 * Normalise a file path coming from Claude Code (Windows paths, or MSYS-style
 * /c/Users/... paths) into an absolute native path.
 */
export function toNativePath(p: string): string {
  let s = p;
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])\/(.*)$/.exec(s);
    if (msys) s = `${msys[1]}:\\${msys[2]}`;
    s = s.replace(/\//g, '\\');
  }
  return path.resolve(s);
}

/** Key used to compare paths (case-insensitive on Windows/macOS default filesystems). */
export function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** True if `child` is `parent` or inside it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
