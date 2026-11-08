# Publishing Checklist (maintainers)

## One-time setup

1. **GitHub repo.** `github.com/chrisTheSE/Coding-Plus-for-Claude-Code`. GitHub repository names cannot contain spaces, so hyphens stand in for them.
2. **Branch protection on `main`:** require pull requests, the CI, CodeQL and Scorecard checks, and signed commits. Turn on private vulnerability reporting under Settings → Security.
3. **Marketplace publisher.**
   - Create it at <https://marketplace.visualstudio.com/manage>.
   - Change `"publisher"` in `package.json` to your publisher ID. Users will see the extension ID as `<publisher>.coding-plus-for-claude-code`.
4. **Trusted Publishing (no stored tokens).**
   - In the publisher's settings, add a Trusted Publishing policy for this repository, the workflow `release.yml`, and the environment `marketplace`.
   - In GitHub, create the environment `marketplace` with required reviewers, and set the repository variable `PUBLISH_MARKETPLACE=true`.
   - Check the current `vsce` docs for the exact flag. This workflow uses `vsce publish --oidc`.
   - If your publisher can't use Trusted Publishing, Microsoft's alternative is Entra workload identity (`--azure-credential`). Avoid personal access tokens; global Azure DevOps PATs are being retired.
5. **Open VSX (optional).**
   - Create a namespace at <https://open-vsx.org>.
   - Add a secret `OVSX_PAT` to the `openvsx` environment.
   - Set `PUBLISH_OPENVSX=true`.
6. **Verified publisher badge.** This needs a domain that you own, and both the domain and the publisher must be at least 6 months old. Start the clock early.

## Each release

1. Bump `version` in `package.json` and `claude-plugin/.claude-plugin/plugin.json`, then update `CHANGELOG.md`.
2. Run `npm run check && npm run test:integration`, then commit, including the rebuilt `claude-plugin/relay.js`.
3. Run `git tag -s vX.Y.Z && git push --tags`.
4. The Release workflow builds the VSIX, SBOM, checksums and provenance and creates the GitHub Release. If publishing is enabled, it then waits for environment approval and publishes.
