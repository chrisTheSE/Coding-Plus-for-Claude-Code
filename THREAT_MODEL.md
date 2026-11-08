# Threat Model

## Assets

1. Source code and secrets on the developer's machine.
2. The integrity of the review: what Claude changed, and what the developer accepted.
3. The integrity of the audit trail.

## Trust boundaries

| Component | Trust |
|---|---|
| Claude Code (official extension / CLI) | Trusted to run hooks it is configured with. Its *model output* is untrusted. |
| Hook payload (stdin JSON) | Untrusted data: it contains model-chosen tool inputs |
| Workspace contents (a cloned repo) | Untrusted |
| User-level settings, data directory | Trusted (same OS user) |

## Threats and mitigations

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | The extension exfiltrates code or data | No network code in either bundle, enforced by a CI check. No telemetry. No runtime dependencies. Unminified bundles for review. | A compromised build pipeline. Mitigated by SLSA provenance, SHA-pinned actions, and reproducible builds that IT can rebuild from the tag. |
| T2 | Claude reads secrets (`.env`, keys) | PreToolUse guard denies, or asks for confirmation, on Read/Edit/Write/Grep/Glob paths and on path-like tokens in Bash/PowerShell commands. Every decision is logged. | **The guard is a guardrail, not a sandbox.** A determined model could reach a secret indirectly, for example a script that builds the filename at runtime, `grep -r` over a directory, or a language-level file read. Combine it with Claude Code `permissions.deny` rules in managed settings, OS-level controls, and not storing plaintext secrets in working trees. |
| T3 | A malicious repository disables the guard | Guard settings are `application`-scoped and cannot be set from workspace settings. Hook installation needs a trusted workspace and explicit consent. | A repo's own `.claude/settings.json` could add *other* hooks. That is Claude Code's trust model, outside this extension. |
| T4 | Hook payload injection (path traversal, huge input, crafted JSON) | The relay parses JSON only, never executes or evaluates input, caps size at 20 MB, writes only to content-addressed paths validated as hex SHA-256 in the data directory, and treats file paths as opaque strings. | None known |
| T5 | Audit log tampering | Hash chain: each entry commits to the previous hash. **Verify Audit Log Integrity** detects edits, deletions and re-ordering. | A local attacker who can rewrite the *whole* file can recompute the chain. For stronger guarantees, forward entries to a SIEM or WORM storage, or periodically record the latest hash somewhere external. |
| T6 | Undo writes wrong content | Hunk math is unit-tested with property tests for byte-identical round-trips, including CRLF and missing final newlines. Undo uses VS Code's WorkspaceEdit, so it is undoable with Ctrl+Z. Files Claude created are moved to the trash, not hard-deleted. | Files over 5 MB and binary files are not snapshotted, so they are not reviewed. |
| T7 | Tampering with `bin/relay.js` in the data directory | The directory is user-only (0700 on POSIX). The file is rewritten from the signed extension package on every VS Code start. | Same-user malware can modify it, but such malware can equally modify the extension directory or Claude Code itself. |
| T8 | Hook breaks Claude Code | The relay fails open for logging errors, so Claude continues. If the guard matched but auditing failed, it fails closed (deny). A 15 s timeout applies. | Hook latency of about 50–100 ms per tool call. |
| T9 | Snapshot store leaks secrets | Guarded files are never snapshotted, because the call is denied first. Snapshots stay in the user-only directory and are pruned by retention. | Unguarded files containing secrets are snapshotted like any other edited file. |

## Out of scope

- The behaviour and data handling of Claude Code itself and its model provider.
- A compromised OS account.
