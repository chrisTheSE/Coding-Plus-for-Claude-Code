# Changelog

## 0.1.0 (unreleased)

- Inline green/red diff for Claude's edits, with Keep/Undo per hunk, per file, or for all changes.
- Changes view with per-hunk items, a side-by-side baseline diff, Explorer badges and a status bar summary.
- Next/previous change navigation across files.
- Add to Claude Chat from the Explorer, editor tabs, editor selections and the Changes view, plus drag and drop.
- Secret guard (deny/ask) for sensitive files, enforced through a PreToolUse hook.
- Local hash-chained audit log with verify and export (JSONL or Markdown).
- Hook installer with a project or user target, plus a managed-settings snippet and a Claude Code plugin.
- Claude chat tabs keep their own editor group; files always open elsewhere.
- Status bar context meter: pie icon with % of context window used; hover for breakdown.
- Detection of files edited through shell commands (git repos only).
