# Privacy & Data Flow

**Summary: this extension collects nothing and sends nothing. All data it creates stays on your machine.**

## What is stored, and where

All data lives in one user-only directory:

| OS | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\claude-review\` |
| macOS | `~/Library/Application Support/claude-review/` |
| Linux | `$XDG_STATE_HOME/claude-review/` (default `~/.local/state/claude-review/`) |

| File | Contents | Retention |
|---|---|---|
| `audit.jsonl` | One JSON line per Claude Code hook event and review action. Fields: time, session id, tool name, file paths, tool input, prompt text, guard decisions, and keep/undo actions. Tool-input strings over 2,000 characters (for example whole file contents) are stored only as SHA-256 plus length. Prompt text is stored only if `claudeReview.audit.recordPrompts` is on; otherwise only its SHA-256. | Kept until you delete it |
| `blobs/` | Full snapshots of files Claude edited, before and after each edit, used to show diffs and to undo. Files over 5 MB are not snapshotted. | Pruned after `claudeReview.retentionDays` (default 30) unless still under review |
| `guard-config.json` | Your secret-guard settings, mirrored here so the hook can read them | Rewritten on settings change |
| `bin/relay.js` | Copy of the hook script, kept at a stable path | Updated on extension start |

VS Code's `workspaceState` holds the list of files pending review and a read offset into the audit log.

## Data flow

```
You ─prompt─▶ Claude Code ─(your configured provider: Anthropic / Bedrock / Vertex)─▶ model
                  │
                  └─ hook (local process) ─▶ relay.js ─▶ audit.jsonl + blobs/   (local disk)
                                                                │
                                         VS Code extension ◀────┘ reads (local disk)
```

The extension never talks to Anthropic, GitHub, Microsoft or anyone else. It does not change what Claude Code sends to its model provider.

## Removing all data

1. Run **Claude Review: Uninstall Claude Code Hooks…**.
2. Uninstall the extension.
3. Delete the data directory listed above.
