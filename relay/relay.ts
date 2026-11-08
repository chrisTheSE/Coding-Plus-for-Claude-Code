// Claude Code hook relay.
//
// Invoked by Claude Code as a `command` hook: `node relay.js`. Reads the hook
// payload (JSON) from stdin, then:
//   1. PreToolUse: enforces the sensitive-file guard (deny/ask) and snapshots
//      the target file before Claude edits it.
//   2. PostToolUse: snapshots the file after the edit.
//   3. Appends a hash-chained entry to the local audit log, which the VS Code
//      extension tails to drive the review UI.
//
// Security properties (see THREAT_MODEL.md):
//   - Uses only Node built-ins: fs, path, os, crypto. No network modules.
//   - Never executes or evaluates anything from the payload.
//   - Input size is capped; malformed input is ignored (exit 0 = no effect).
//   - Any internal error fails OPEN for normal events (Claude keeps working)
//     but is reported on stderr; the guard itself fails CLOSED if it matched.
import { appendAudit, AuditEntryBody } from '../src/shared/auditLog';
import { sha256, snapshotFile } from '../src/shared/blobStore';
import { checkToolCall, readGuardConfig, relativeTo } from '../src/shared/guard';
import * as path from 'node:path';
import { APP_DIR, dataRoot, toNativePath } from '../src/shared/paths';

const MAX_STDIN = 20 * 1024 * 1024;
const MAX_INLINE_STRING = 2000;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

interface HookPayload {
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  prompt?: string;
  message?: string;
  permission_mode?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_STDIN) {
        reject(new Error('hook payload too large'));
        process.stdin.destroy();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Replace large strings (file contents etc.) with a hash so the audit log stays small. */
export function summariseInput(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_INLINE_STRING ? { sha256: sha256(v), len: v.length } : v;
  }
  if (depth > 6) return '[depth limit]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => summariseInput(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = summariseInput(x, depth + 1);
    return o;
  }
  return v;
}

function targetFile(p: HookPayload): string | undefined {
  const i = p.tool_input ?? {};
  const f = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : undefined;
  return f ? toNativePath(f) : undefined;
}

export function handle(p: HookPayload, root = dataRoot()): { stdout?: string } {
  const event = p.hook_event_name ?? 'unknown';
  const cfg = readGuardConfig(root);
  const body: AuditEntryBody = {
    v: 1,
    ts: new Date().toISOString(),
    src: 'hook',
    event,
    session: p.session_id,
    promptId: p.prompt_id,
    cwd: p.cwd,
  };
  let stdout: string | undefined;

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    const tool = p.tool_name ?? '';
    const input = (p.tool_input ?? {}) as Record<string, unknown>;
    body.tool = tool;
    body.toolUseId = p.tool_use_id;
    body.input = summariseInput(input);
    const file = targetFile(p);
    if (file) body.files = [file];

    if (event === 'PreToolUse') {
      const hit = checkToolCall(tool, input, cfg);
      if (hit) {
        body.decision = cfg.action;
        body.reason = `sensitive path "${relativeTo(p.cwd, hit.path)}" matches pattern "${hit.pattern}"`;
        stdout = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: cfg.action,
            permissionDecisionReason:
              `Blocked by Coding Plus for Claude Code secret guard: ${body.reason}. ` +
              'This file may contain credentials. Ask the user to share the specific non-secret details you need instead.',
          },
        });
      } else if (file && EDIT_TOOLS.has(tool)) {
        body.before = snapshotFile(root, file);
      }
    } else if (file && EDIT_TOOLS.has(tool)) {
      body.after = snapshotFile(root, file);
    }
  } else if (event === 'UserPromptSubmit') {
    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    body.promptSha256 = sha256(prompt);
    if (cfg.recordPrompts) body.prompt = prompt.length > 20000 ? prompt.slice(0, 20000) + '…[truncated]' : prompt;
  } else if (event === 'Notification') {
    body.detail = { message: typeof p.message === 'string' ? p.message.slice(0, 2000) : undefined };
  } else if (event === 'SessionStart' || event === 'Stop' || event === 'SessionEnd') {
    body.detail = { permissionMode: p.permission_mode };
  }

  appendAudit(root, body);
  return { stdout };
}

/**
 * Data root for this relay: if installed at <root>/bin/relay.js (the copy the
 * extension maintains), use <root>; otherwise (e.g. plugin copy) the default.
 */
export function relayRoot(scriptPath: string = __filename): string {
  const binDir = path.dirname(scriptPath);
  const parent = path.dirname(binDir);
  if (path.basename(binDir) === 'bin' && path.basename(parent).toLowerCase() === APP_DIR) return parent;
  return dataRoot();
}

export async function main(): Promise<void> {
  let payload: HookPayload;
  try {
    const text = await readStdin();
    payload = JSON.parse(text) as HookPayload;
    if (!payload || typeof payload !== 'object') return;
  } catch (e) {
    process.stderr.write(`claude-review relay: ignoring invalid input: ${(e as Error).message}\n`);
    return;
  }
  try {
    const { stdout } = handle(payload, relayRoot());
    if (stdout) process.stdout.write(stdout);
  } catch (e) {
    process.stderr.write(`claude-review relay error: ${(e as Error).message}\n`);
    // Fail closed only if the guard would have blocked: re-check without I/O.
    try {
      if (payload.hook_event_name === 'PreToolUse') {
        const cfg = readGuardConfig(relayRoot());
        const hit = checkToolCall(payload.tool_name ?? '', (payload.tool_input ?? {}) as Record<string, unknown>, cfg);
        if (hit) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by secret guard (audit write failed).' },
          }));
        }
      }
    } catch { /* ignore */ }
  }
}

