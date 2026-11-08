// Sensitive-file guard: decides whether a Claude Code tool call touches a
// path matching sensitive glob patterns. Used by the hook relay (PreToolUse).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardConfigPath } from './paths';

export interface GuardConfig {
  enabled: boolean;
  action: 'deny' | 'ask';
  patterns: string[];
  allowPatterns: string[];
  recordPrompts: boolean;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  action: 'deny',
  patterns: [
    '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.jks', '*.keystore',
    'id_rsa*', 'id_ecdsa*', 'id_ed25519*', 'id_dsa*', '.npmrc', '.pypirc', '.netrc',
    'credentials', 'credentials.json', '**/.aws/**', '**/.ssh/**', '**/secrets/**', '*.tfstate', '*.tfvars',
  ],
  allowPatterns: ['.env.example', '.env.sample', '.env.template', '*.pub'],
  recordPrompts: true,
};

export function readGuardConfig(root: string): GuardConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(guardConfigPath(root), 'utf8')) as Partial<GuardConfig>;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_GUARD_CONFIG.enabled,
      action: raw.action === 'ask' ? 'ask' : 'deny',
      patterns: Array.isArray(raw.patterns) ? raw.patterns.filter((x) => typeof x === 'string') : DEFAULT_GUARD_CONFIG.patterns,
      allowPatterns: Array.isArray(raw.allowPatterns) ? raw.allowPatterns.filter((x) => typeof x === 'string') : DEFAULT_GUARD_CONFIG.allowPatterns,
      recordPrompts: typeof raw.recordPrompts === 'boolean' ? raw.recordPrompts : true,
    };
  } catch {
    return DEFAULT_GUARD_CONFIG;
  }
}

export function writeGuardConfig(root: string, cfg: GuardConfig): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(guardConfigPath(root), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Convert a glob (`*`, `**`, `?`) to a RegExp anchored on both ends. */
export function globToRegExp(glob: string, caseInsensitive = process.platform === 'win32'): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

function matchesAny(p: string, patterns: string[]): string | undefined {
  const posix = p.replace(/\\/g, '/');
  const base = posix.split('/').pop() || posix;
  for (const pat of patterns) {
    const rx = globToRegExp(pat);
    if (pat.includes('/')) {
      // Path pattern: test the full path and every suffix of it.
      const parts = posix.split('/');
      for (let i = 0; i < parts.length; i++) {
        if (rx.test(parts.slice(i).join('/'))) return pat;
      }
      // Also allow `**/dir/**` to match a directory path itself.
      if (rx.test(posix + '/')) return pat;
    } else if (rx.test(base)) {
      return pat;
    }
  }
  return undefined;
}

/** Returns the matching pattern if `p` is sensitive, else undefined. */
export function sensitiveMatch(p: string, cfg: GuardConfig): string | undefined {
  if (!p) return undefined;
  if (matchesAny(p, cfg.allowPatterns)) return undefined;
  return matchesAny(p, cfg.patterns);
}

/** Split a shell command into rough tokens (handles quotes; good enough for path detection). */
export function shellTokens(cmd: string): string[] {
  const out: string[] = [];
  const rx = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;|&<>()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Collect candidate paths referenced by a tool call. */
export function pathsForTool(tool: string, input: Record<string, unknown>): string[] {
  const s = (k: string) => (typeof input[k] === 'string' ? [input[k] as string] : []);
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return s('file_path');
    case 'NotebookEdit':
    case 'NotebookRead':
      return s('notebook_path');
    case 'Grep':
      return [...s('path'), ...s('glob')];
    case 'Glob':
      return [...s('path'), ...s('pattern')];
    case 'Bash':
    case 'PowerShell':
      return typeof input.command === 'string'
        ? shellTokens(input.command).flatMap((t) => {
            // Strip redirection / assignment prefixes like >file or VAR=file.
            const cleaned = t.replace(/^[0-9]*[<>]+/, '');
            const eq = cleaned.indexOf('=');
            return eq > 0 ? [cleaned, cleaned.slice(eq + 1)] : [cleaned];
          })
        : [];
    default:
      return [];
  }
}

export interface GuardDecision {
  path: string;
  pattern: string;
}

export function checkToolCall(tool: string, input: Record<string, unknown>, cfg: GuardConfig): GuardDecision | undefined {
  if (!cfg.enabled) return undefined;
  for (const p of pathsForTool(tool, input)) {
    const pattern = sensitiveMatch(p, cfg);
    if (pattern) return { path: p, pattern };
  }
  return undefined;
}

export function relativeTo(cwd: string | undefined, p: string): string {
  if (!cwd) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}
