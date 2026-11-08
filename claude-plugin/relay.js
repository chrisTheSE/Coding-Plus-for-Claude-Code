"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/shared/auditLog.ts
var fs2 = __toESM(require("node:fs"));

// src/shared/canonicalJson.ts
function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const x = v[k];
      if (x !== void 0) out[k] = sortValue(x);
    }
    return out;
  }
  return v;
}

// src/shared/blobStore.ts
var crypto = __toESM(require("node:crypto"));
var fs = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));

// src/shared/paths.ts
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var APP_DIR = "claude-review";
function dataRoot(env = process.env) {
  if (env.CLAUDE_REVIEW_HOME) return path.resolve(env.CLAUDE_REVIEW_HOME);
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), APP_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR);
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), APP_DIR);
}
var auditLogPath = (root) => path.join(root, "audit.jsonl");
var auditLockPath = (root) => path.join(root, "audit.lock");
var blobDir = (root) => path.join(root, "blobs");
var guardConfigPath = (root) => path.join(root, "guard-config.json");
function toNativePath(p) {
  let s = p;
  if (process.platform === "win32") {
    const msys = /^\/([a-zA-Z])\/(.*)$/.exec(s);
    if (msys) s = `${msys[1]}:\\${msys[2]}`;
    s = s.replace(/\//g, "\\");
  }
  return path.resolve(s);
}

// src/shared/blobStore.ts
var MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function blobPath(root, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid blob hash: ${hash}`);
  return path2.join(blobDir(root), hash.slice(0, 2), hash);
}
function putBlob(root, data) {
  const hash = sha256(data);
  const p = blobPath(root, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path2.dirname(p), { recursive: true, mode: 448 });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 384 });
    try {
      fs.renameSync(tmp, p);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
    }
  } else {
    const now = /* @__PURE__ */ new Date();
    try {
      fs.utimesSync(p, now, now);
    } catch {
    }
  }
  return hash;
}
function snapshotFile(root, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return void 0;
  try {
    return putBlob(root, fs.readFileSync(file));
  } catch {
    return void 0;
  }
}

// src/shared/auditLog.ts
var GENESIS = "0".repeat(64);
function computeHash(prev, body) {
  return sha256(prev + canonicalJson(body));
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock(root, fn) {
  const lock = auditLockPath(root);
  const deadline = Date.now() + 5e3;
  for (; ; ) {
    try {
      const fd = fs2.openSync(lock, "wx", 384);
      fs2.writeSync(fd, String(process.pid));
      fs2.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs2.statSync(lock).mtimeMs > 1e4) fs2.unlinkSync(lock);
      } catch {
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for audit log lock");
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs2.unlinkSync(lock);
    } catch {
    }
  }
}
function readLastEntry(file) {
  let fd;
  try {
    fd = fs2.openSync(file, "r");
  } catch {
    return void 0;
  }
  try {
    const size = fs2.fstatSync(fd).size;
    if (size === 0) return void 0;
    let chunk = 64 * 1024;
    for (; ; ) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs2.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8").replace(/\n+$/, "");
      const nl = text.lastIndexOf("\n");
      if (nl >= 0 || start === 0) {
        return JSON.parse(text.slice(nl + 1));
      }
      chunk *= 4;
    }
  } finally {
    fs2.closeSync(fd);
  }
}
function appendAudit(root, body) {
  fs2.mkdirSync(root, { recursive: true, mode: 448 });
  const file = auditLogPath(root);
  return withLock(root, () => {
    const last = readLastEntry(file);
    const prev = last ? last.hash : GENESIS;
    const seq = last ? last.seq + 1 : 1;
    const unhashed = { ...body, seq, prev };
    const entry = { ...unhashed, hash: computeHash(prev, unhashed) };
    fs2.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 384 });
    return entry;
  });
}

// src/shared/guard.ts
var fs3 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
var DEFAULT_GUARD_CONFIG = {
  enabled: true,
  action: "deny",
  patterns: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.jks",
    "*.keystore",
    "id_rsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "id_dsa*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "credentials",
    "credentials.json",
    "**/.aws/**",
    "**/.ssh/**",
    "**/secrets/**",
    "*.tfstate",
    "*.tfvars"
  ],
  allowPatterns: [".env.example", ".env.sample", ".env.template", "*.pub"],
  recordPrompts: true
};
function readGuardConfig(root) {
  try {
    const raw = JSON.parse(fs3.readFileSync(guardConfigPath(root), "utf8"));
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_GUARD_CONFIG.enabled,
      action: raw.action === "ask" ? "ask" : "deny",
      patterns: Array.isArray(raw.patterns) ? raw.patterns.filter((x) => typeof x === "string") : DEFAULT_GUARD_CONFIG.patterns,
      allowPatterns: Array.isArray(raw.allowPatterns) ? raw.allowPatterns.filter((x) => typeof x === "string") : DEFAULT_GUARD_CONFIG.allowPatterns,
      recordPrompts: typeof raw.recordPrompts === "boolean" ? raw.recordPrompts : true
    };
  } catch {
    return DEFAULT_GUARD_CONFIG;
  }
}
function globToRegExp(glob, caseInsensitive = process.platform === "win32") {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}
function matchesAny(p, patterns) {
  const posix = p.replace(/\\/g, "/");
  const base = posix.split("/").pop() || posix;
  for (const pat of patterns) {
    const rx = globToRegExp(pat);
    if (pat.includes("/")) {
      const parts = posix.split("/");
      for (let i = 0; i < parts.length; i++) {
        if (rx.test(parts.slice(i).join("/"))) return pat;
      }
      if (rx.test(posix + "/")) return pat;
    } else if (rx.test(base)) {
      return pat;
    }
  }
  return void 0;
}
function sensitiveMatch(p, cfg) {
  if (!p) return void 0;
  if (matchesAny(p, cfg.allowPatterns)) return void 0;
  return matchesAny(p, cfg.patterns);
}
function shellTokens(cmd) {
  const out = [];
  const rx = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;|&<>()]+)/g;
  let m;
  while (m = rx.exec(cmd)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function pathsForTool(tool, input) {
  const s = (k) => typeof input[k] === "string" ? [input[k]] : [];
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return s("file_path");
    case "NotebookEdit":
    case "NotebookRead":
      return s("notebook_path");
    case "Grep":
      return [...s("path"), ...s("glob")];
    case "Glob":
      return [...s("path"), ...s("pattern")];
    case "Bash":
    case "PowerShell":
      return typeof input.command === "string" ? shellTokens(input.command).flatMap((t) => {
        const cleaned = t.replace(/^[0-9]*[<>]+/, "");
        const eq = cleaned.indexOf("=");
        return eq > 0 ? [cleaned, cleaned.slice(eq + 1)] : [cleaned];
      }) : [];
    default:
      return [];
  }
}
function checkToolCall(tool, input, cfg) {
  if (!cfg.enabled) return void 0;
  for (const p of pathsForTool(tool, input)) {
    const pattern = sensitiveMatch(p, cfg);
    if (pattern) return { path: p, pattern };
  }
  return void 0;
}
function relativeTo(cwd, p) {
  if (!cwd) return p;
  const rel = path3.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path3.isAbsolute(rel) ? rel : p;
}

// relay/relay.ts
var path4 = __toESM(require("node:path"));
var MAX_STDIN = 20 * 1024 * 1024;
var MAX_INLINE_STRING = 2e3;
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
function readStdin() {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > MAX_STDIN) {
        reject(new Error("hook payload too large"));
        process.stdin.destroy();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}
function summariseInput(v, depth = 0) {
  if (typeof v === "string") {
    return v.length > MAX_INLINE_STRING ? { sha256: sha256(v), len: v.length } : v;
  }
  if (depth > 6) return "[depth limit]";
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => summariseInput(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = summariseInput(x, depth + 1);
    return o;
  }
  return v;
}
function targetFile(p) {
  const i = p.tool_input ?? {};
  const f = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : void 0;
  return f ? toNativePath(f) : void 0;
}
function handle(p, root = dataRoot()) {
  const event = p.hook_event_name ?? "unknown";
  const cfg = readGuardConfig(root);
  const body = {
    v: 1,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    src: "hook",
    event,
    session: p.session_id,
    promptId: p.prompt_id,
    cwd: p.cwd
  };
  let stdout;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const tool = p.tool_name ?? "";
    const input = p.tool_input ?? {};
    body.tool = tool;
    body.toolUseId = p.tool_use_id;
    body.input = summariseInput(input);
    const file = targetFile(p);
    if (file) body.files = [file];
    if (event === "PreToolUse") {
      const hit = checkToolCall(tool, input, cfg);
      if (hit) {
        body.decision = cfg.action;
        body.reason = `sensitive path "${relativeTo(p.cwd, hit.path)}" matches pattern "${hit.pattern}"`;
        stdout = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: cfg.action,
            permissionDecisionReason: `Blocked by Coding Plus for Claude Code secret guard: ${body.reason}. This file may contain credentials. Ask the user to share the specific non-secret details you need instead.`
          }
        });
      } else if (file && EDIT_TOOLS.has(tool)) {
        body.before = snapshotFile(root, file);
      }
    } else if (file && EDIT_TOOLS.has(tool)) {
      body.after = snapshotFile(root, file);
    }
  } else if (event === "UserPromptSubmit") {
    const prompt = typeof p.prompt === "string" ? p.prompt : "";
    body.promptSha256 = sha256(prompt);
    if (cfg.recordPrompts) body.prompt = prompt.length > 2e4 ? prompt.slice(0, 2e4) + "\u2026[truncated]" : prompt;
  } else if (event === "Notification") {
    body.detail = { message: typeof p.message === "string" ? p.message.slice(0, 2e3) : void 0 };
  } else if (event === "SessionStart" || event === "Stop" || event === "SessionEnd") {
    body.detail = { permissionMode: p.permission_mode };
  }
  appendAudit(root, body);
  return { stdout };
}
function relayRoot(scriptPath = __filename) {
  const binDir = path4.dirname(scriptPath);
  const parent = path4.dirname(binDir);
  if (path4.basename(binDir) === "bin" && path4.basename(parent).toLowerCase() === APP_DIR) return parent;
  return dataRoot();
}
async function main() {
  let payload;
  try {
    const text = await readStdin();
    payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") return;
  } catch (e) {
    process.stderr.write(`claude-review relay: ignoring invalid input: ${e.message}
`);
    return;
  }
  try {
    const { stdout } = handle(payload, relayRoot());
    if (stdout) process.stdout.write(stdout);
  } catch (e) {
    process.stderr.write(`claude-review relay error: ${e.message}
`);
    try {
      if (payload.hook_event_name === "PreToolUse") {
        const cfg = readGuardConfig(relayRoot());
        const hit = checkToolCall(payload.tool_name ?? "", payload.tool_input ?? {}, cfg);
        if (hit) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by secret guard (audit write failed)." }
          }));
        }
      }
    } catch {
    }
  }
}

// relay/main.ts
void main();
