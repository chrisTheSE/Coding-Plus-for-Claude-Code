# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Report vulnerabilities through GitHub's private advisory form for this repository: Security → Report a vulnerability.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation within 30 days for high-severity issues.

## Supported versions

Only the latest released version receives security fixes.

## Security design summary

- The extension and the hook relay make **no network connections**. CI fails if a bundle references `http`, `https`, `net`, `tls`, `dgram`, `dns`, `fetch`, `WebSocket`, `XMLHttpRequest`, `eval`, `new Function`, `exec` or `shell: true`. See `scripts/check-no-network.mjs`.
- **No runtime dependencies.** The VSIX contains only `dist/extension.js`, `dist/relay.js`, icons and docs. Both bundles are unminified and include source maps for review.
- The relay **never executes** anything from the hook payload. It reads JSON from stdin, with a 20 MB cap, and writes files only inside the data directory.
- The only process the extension starts is `git`, via `execFile` with an argument array (no shell).
- Settings that affect safety (`secretGuard.*`, `audit.recordPrompts`, `hookCommand`, `retentionDays`) are `application`-scoped, so workspace settings cannot override them. `hookCommand` is also restricted in untrusted workspaces.
- Hook installation requires a trusted workspace and explicit confirmation that shows the exact command and file.

## Verifying a release

Each GitHub Release includes the VSIX, a CycloneDX SBOM, `SHA256SUMS.txt` and a SLSA build-provenance attestation:

```
gh attestation verify coding-plus-for-claude-code-vX.Y.Z.vsix --repo chrisTheSE/Coding-Plus-for-Claude-Code
sha256sum -c SHA256SUMS.txt
```

You can also rebuild from the tag (`npm ci && npm run build`) and compare `dist/*.js`. See [docs/ENTERPRISE.md](docs/ENTERPRISE.md).
