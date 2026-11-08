# Coding Plus for Claude Code

**GitHub Copilot–style review UX for [Claude Code](https://code.claude.com) in VS Code. It runs locally, makes no network connections, and is auditable.**

Let Claude Code work in auto mode, then review everything it changed the way you would with Copilot:

- **Inline green/red diffs** in the normal editor. Added and changed lines are highlighted. Removed lines appear as a red marker with ghost text, and hovering shows the original code.
- **Keep / Undo per change** via CodeLens, hover links, and the editor context menu (`Ctrl+Alt+Y` / `Ctrl+Alt+N`). You can also keep or undo a whole file, or everything at once.
- **Changes view** listing every file Claude touched, with `+/−` counts, per-hunk entries, a side-by-side diff against the pre-Claude baseline, Explorer badges, and a status bar summary.
- **Next/previous change navigation** across files (`Alt+F5` / `Shift+Alt+F5`).
- **Add to Claude Chat** from a right-click on files, folders, multi-selections, editor tabs, and editor selections. It works with the official Claude Code extension's chat, or with `claude` running in a terminal.
- **Drag and drop**: drag items from the Changes view into the Claude chat input, or drop files from the Explorer onto the Changes view to add them to the chat.
- **Secret guard** blocks Claude from reading or editing `.env`, keys, certificates, `.ssh`, `.aws`, `secrets/**` and similar files. This applies to `Read`, `Grep`, `Edit` and `Write`, and to paths mentioned in shell commands.
- **Claude chat stays in its own editor group**, like Copilot Chat: files never open next to a Claude chat tab, but additional Claude chats can. The group is locked through VS Code's `workbench.editor.autoLockGroups`, and any stray file is moved out. Setting: `claudeReview.isolateClaudeChat`.
- **Context meter** — a pie icon (○ ◔ ◑ ◕ ●) in the status bar fills as the current Claude session uses its context window; hover for exact % and token breakdown (read from the local session transcript).
- **Tamper-evident audit log**: every prompt, tool call, blocked call and review decision goes into a local, hash-chained JSONL file. A command verifies its integrity, and you can export it as JSONL or as a Markdown report for change tickets.

> This is an independent open-source project and is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic. It complements the official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) and does not replace it. Claude keeps running under your own Claude Code login or your company's Bedrock/Vertex configuration.

## How it works

```
Claude Code (official extension or CLI, auto mode)
   │  command hooks: PreToolUse / PostToolUse / UserPromptSubmit / Stop …
   ▼
relay.js (Node built-ins only)
   ├─ secret guard → deny/ask, logged
   ├─ file snapshot before & after each edit → <data>/blobs/<sha256>
   └─ append hash-chained entry → <data>/audit.jsonl
   ▼
VS Code extension (tails audit.jsonl)
   └─ ChangeModel → inline diff · CodeLens · Changes view · badges · Keep/Undo
```

`<data>` is `%LOCALAPPDATA%\claude-review` on Windows, `~/Library/Application Support/claude-review` on macOS, and `~/.local/state/claude-review` on Linux.

Because review is driven by hooks, it works the same whatever Claude Code's permission mode is, including auto-accept, and whether you use the VS Code panel or the CLI.

## Getting started

1. Install the official **Claude Code** extension, plus this extension.
2. Run **Claude Review: Install Claude Code Hooks…** and choose **This project** (`.claude/settings.local.json`) or **All projects** (`~/.claude/settings.json`). The command shows you exactly what it will write. Your existing hooks are preserved, and a backup is saved.
3. Start a new Claude session and ask it to change some code. Changed lines light up in green and red, and the **Claude Review** activity-bar view lists the files.

Node.js on `PATH` is recommended for running the hook. Without it, the extension falls back to VS Code's bundled runtime.

Alternatively, install the hooks as a Claude Code plugin:

```
/plugin marketplace add chrisTheSE/Coding-Plus-for-Claude-Code
/plugin install coding-plus-for-claude-code@coding-plus-for-claude-code
```

## Security & privacy

- **No network.** The extension and relay contain no HTTP, socket, DNS, `fetch`, WebSocket, `eval` or shell-spawn code. CI enforces this with [`scripts/check-no-network.mjs`](scripts/check-no-network.mjs). There is no telemetry.
- **No runtime dependencies.** The shipped code is two readable, unminified bundles, `dist/extension.js` and `dist/relay.js`, built only from this repository's source and Node/VS Code built-ins. The diff algorithm is implemented in-repo.
- **Local data only.** Snapshots and the audit log stay on your machine, in a user-only directory. Snapshots are pruned after `claudeReview.retentionDays`. The audit log is never deleted automatically.
- **The only child process is `git`**, run via `execFile` with an argument array, to read `HEAD` versions and detect shell-made edits.
- **Security-relevant settings are user-level only** (`application` scope), so a cloned repository's `.vscode/settings.json` cannot switch off the secret guard.
- Supply chain: SHA-pinned GitHub Actions, CodeQL, OpenSSF Scorecard, Dependabot, `npm audit signatures`, CycloneDX SBOM, and SLSA build provenance on every release.

See [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), [THREAT_MODEL.md](THREAT_MODEL.md) and, for IT and security teams, [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

Claude Code itself sends your prompts and code to your configured model provider (Anthropic, or Amazon Bedrock / Google Vertex AI in your own cloud account). This extension does not change or intercept that traffic.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeReview.inlineDiff.enabled` | `true` | Inline green/red highlighting |
| `claudeReview.codeLens.enabled` | `true` | Keep / Undo / Diff above each change |
| `claudeReview.trackBashEdits` | `true` | Detect files changed by shell commands (git repos), with HEAD as the baseline |
| `claudeReview.addToChat.method` | `auto` | `auto` · `mention` · `paste` · `terminal` |
| `claudeReview.secretGuard.enabled` | `true` | Block sensitive files (user-level setting) |
| `claudeReview.secretGuard.action` | `deny` | `deny` or `ask` |
| `claudeReview.secretGuard.patterns` / `allowPatterns` | see package.json | Glob lists |
| `claudeReview.audit.recordPrompts` | `true` | Store prompt text, or only its SHA-256 |
| `claudeReview.retentionDays` | `30` | Snapshot retention |
| `claudeReview.contextMeter.enabled` | `true` | Status bar context-usage pie |
| `claudeReview.contextMeter.showPercent` | `false` | Show the % next to the pie |
| `claudeReview.contextMeter.contextWindow` | `0` | Window size in tokens (0 = estimate) |

## Limitations

- The official Claude chat panel is a closed webview. "Add to Chat" uses its public `insertAtMention` and `focus` commands, and pastes for folders. Prompts can be pre-filled but never auto-sent.
- Deleted lines are shown as a marker and hover, not as real "virtual lines". Copilot uses a proposed VS Code API that third-party extensions cannot ship. Use **Open Side-by-Side Diff** for the full view.
- Files changed by shell commands are detected only in git repositories, against `HEAD`.
- The secret guard is a guardrail, not a sandbox. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Development

```
npm ci
npm run check              # typecheck, build, no-network check, unit tests
npm run test:integration   # runs inside a real VS Code instance
```

Press **F5** in VS Code to launch an Extension Development Host. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
