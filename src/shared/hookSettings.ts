// Pure helpers to merge/remove this project's hooks in a Claude Code
// settings object without touching anyone else's hooks.

export const HOOK_MARKER = 'claude-review';
export const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
export const OTHER_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionStart', 'Notification'];

export interface HookCommand { type: 'command'; command: string; timeout?: number }
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HooksBlock = Record<string, HookMatcher[]>;

export function hooksBlock(command: string): HooksBlock {
  const h: HookCommand = { type: 'command', command, timeout: 15 };
  const block: HooksBlock = {};
  for (const ev of TOOL_EVENTS) block[ev] = [{ matcher: '*', hooks: [h] }];
  for (const ev of OTHER_EVENTS) block[ev] = [{ hooks: [h] }];
  return block;
}

export function isOurs(h: HookCommand): boolean {
  return !!h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER) && h.command.includes('relay.js');
}

function stripOurs(hooks: HooksBlock): HooksBlock {
  const out: HooksBlock = {};
  for (const [ev, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) { out[ev] = matchers; continue; }
    const kept = matchers
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length);
    if (kept.length) out[ev] = kept;
  }
  return out;
}

/** Add (command given) or remove (command undefined) our hooks. Idempotent. */
export function mergeHooks(settings: Record<string, unknown>, command: string | undefined): Record<string, unknown> {
  const existing = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as HooksBlock;
  const hooks = stripOurs(existing);
  if (command) {
    for (const [ev, matchers] of Object.entries(hooksBlock(command))) {
      hooks[ev] = [...(hooks[ev] ?? []), ...matchers];
    }
  }
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}
