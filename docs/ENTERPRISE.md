# Enterprise Deployment Guide (for IT / Security teams)

This guide explains how to approve, build, distribute and configure Coding Plus for Claude Code in a regulated environment such as a bank.

## 1. What you are approving

| Property | Detail |
|---|---|
| License | MIT |
| Network | None. The extension and hook make no network connections; CI enforces this (`scripts/check-no-network.mjs`). |
| Telemetry | None |
| Runtime dependencies | None. The VSIX ships two unminified JS bundles plus icons and docs. |
| Processes started | `git` (via `execFile`, no shell) by the extension. Claude Code starts `node relay.js` as a hook. |
| Data written | One user-only directory (see [PRIVACY.md](../PRIVACY.md)), plus the hook entries in the Claude settings file you choose |
| Review artefacts | [THREAT_MODEL.md](../THREAT_MODEL.md), [SECURITY.md](../SECURITY.md), CycloneDX SBOM, SLSA provenance |

## 2. Build it yourself (recommended)

Most security teams prefer to rebuild from source instead of trusting a binary.

```bash
git clone https://github.com/chrisTheSE/Coding-Plus-for-Claude-Code && cd coding-plus-for-claude-code
git checkout vX.Y.Z                       # optionally verify the tag signature: git tag -v vX.Y.Z
npm ci --ignore-scripts                   # dev-only toolchain, pinned by package-lock.json
npm audit signatures
npm run check                             # typecheck, build, no-network check, unit tests
npx vsce package --no-dependencies        # produces coding-plus-for-claude-code-X.Y.Z.vsix
```

Compare your `dist/extension.js` and `dist/relay.js` with the ones in the published VSIX. A VSIX is a zip file, so `unzip -l` lists its contents. Or verify the published artefact directly:

```bash
gh attestation verify coding-plus-for-claude-code-vX.Y.Z.vsix --repo chrisTheSE/Coding-Plus-for-Claude-Code
```

## 3. Distribute to developer machines

Choose one option.

**A. Private Extension Marketplace** (requires GitHub Enterprise). Host your rebuilt VSIX in your organisation's private marketplace and roll out with your usual policy.

**B. Allow-list plus VSIX.** Use VS Code's `AllowedExtensions` policy, available through Windows Group Policy (ADMX ships with VS Code), the macOS profile, or Linux `policy.json`. Pin it to the approved version:

```json
{
  "anthropic.claude-code": true,
  "christhese.coding-plus-for-claude-code": ["0.1.0"]
}
```

Then deploy the VSIX with `code --install-extension coding-plus-for-claude-code-0.1.0.vsix` from your software-distribution tool.

Note: an allow-list rule for a VSIX matches the identifier declared *inside* the package. It does not prove where the package came from, so distribute only VSIX files you built or verified.

## 4. Allow the hooks under managed Claude Code settings

If your managed settings use `allowManagedHooksOnly: true`, user and project hooks are ignored, so this extension's installer has no effect. Allow its hooks centrally instead, using one of these options.

**Option 1: put the hooks in managed settings.** On a machine with the extension installed, run **Claude Review: Copy Managed-Settings Hook Snippet**, adjust the paths for your fleet, and merge the result into managed settings. Managed settings live at `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, or in the `HKLM\SOFTWARE\Policies\ClaudeCode` registry key. The snippet looks like this:

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/%USERNAME%/AppData/Local/claude-review/bin/relay.js\"", "timeout": 15 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "…same…", "timeout": 15 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "…same…" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "…same…" }] }],
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "…same…" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "…same…" }] }]
  }
}
```

Use a fleet-wide path. For example, deploy `relay.js` from the release to `C:\Program Files\ClaudeReview\relay.js` and point the hooks at it. In that case set `CLAUDE_REVIEW_HOME` for users, or rely on the default per-user data directory. The relay uses the default per-user data root unless it runs from `<root>/bin/`.

**Option 2: the Claude Code plugin.** Host this repository, or your fork, in an internal Git server and force-enable the plugin through managed `enabledPlugins` / `extraKnownMarketplaces`. The plugin is in `claude-plugin/` and its `relay.js` is committed. CI checks that it is byte-identical to the build output.

Hook behaviour differs between Claude Code versions. Test against the version you deploy.

## 5. Recommended Claude Code settings for regulated environments

- Route model traffic through **Amazon Bedrock** or **Google Vertex AI** in your own cloud account.
- Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Add `permissions.deny` rules for secret paths in managed settings, for example `Read(**/.env*)`. These work alongside this extension's guard, which also logs every block.
- Forward `audit.jsonl` to your SIEM if you need central retention. The file is append-only JSON Lines with a hash chain (see [THREAT_MODEL.md](../THREAT_MODEL.md), T5).

## 6. Guard policy

The defaults block `.env*` (except `.example`, `.sample` and `.template`), `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.jks`, `*.keystore`, SSH keys, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `**/.aws/**`, `**/.ssh/**`, `**/secrets/**`, `*.tfstate` and `*.tfvars`.

The guard settings are user-level (`application` scope). To enforce them centrally, deploy VS Code user settings with your configuration-management tool.
