// Reads Claude Code session transcripts (local JSONL files under
// ~/.claude/projects/<encoded-cwd>/<session>.jsonl) to compute how much of the
// model's context window the current session is using. Read-only, local only.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ContextUsage {
  sessionId: string;
  transcript: string;
  model: string;
  /** Tokens currently in context: input + cache write + cache read + output of the latest main-thread turn. */
  tokens: number;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** ISO timestamp of the assistant message the usage came from. */
  at: string;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/** Claude Code names project folders by replacing every non-alphanumeric character of the cwd with '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Find the transcript folders for a workspace path (case-insensitive: drive letters vary). */
export function projectDirsFor(configDir: string, workspacePath: string): string[] {
  const base = path.join(configDir, 'projects');
  const want = encodeProjectDir(workspacePath).toLowerCase();
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.toLowerCase() === want)
      .map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}

/** Newest top-level session transcript across the given folders (subagent transcripts live in subfolders and are ignored). */
export function newestTranscript(dirs: string[]): { file: string; mtimeMs: number; size: number } | undefined {
  let best: { file: string; mtimeMs: number; size: number } | undefined;
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs, size: st.size };
      } catch { /* ignore */ }
    }
  }
  return best;
}

/** Parse transcript text and return usage from the last main-thread assistant message. */
export function usageFromText(text: string, transcript = ''): ContextUsage | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let e: TranscriptLine;
    try { e = JSON.parse(line) as TranscriptLine; } catch { continue; }
    if (e.type !== 'assistant' || e.isSidechain || !e.message?.usage) continue;
    const model = e.message.model ?? '';
    if (model === '<synthetic>') continue;
    const u = e.message.usage;
    const input = u.input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    return {
      sessionId: e.sessionId ?? path.basename(transcript, '.jsonl'),
      transcript,
      model,
      tokens: input + cacheCreation + cacheRead + output,
      input,
      cacheCreation,
      cacheRead,
      output,
      at: e.timestamp ?? '',
    };
  }
  return undefined;
}

/** Read only the tail of a (possibly large) transcript, growing the window until a usage record is found. */
export function readUsage(file: string): ContextUsage | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let chunk = 256 * 1024; ; chunk *= 4) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
      const u = usageFromText(text, file);
      if (u || start === 0 || chunk >= 64 * 1024 * 1024) return u;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Context window for a model. Claude Code does not record the window in the
 * transcript, so: explicit override > "[1m]" model suffix > observed usage
 * already above 200K (the session must have a larger window) > 200K.
 */
export function contextWindowFor(model: string, tokens: number, override = 0): number {
  if (override > 0) return override;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  if (tokens > 200_000) return 1_000_000;
  return 200_000;
}
