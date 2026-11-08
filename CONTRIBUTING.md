# Contributing

Thanks for helping! Some ground rules keep this project easy for security teams to approve.

1. **No runtime dependencies.** Shipped code may import only Node built-ins and `vscode`. Dev dependencies need a justification in the PR.
2. **No network code in shipped bundles.** `npm run check:no-network` must pass, and this is non-negotiable.
3. **No shell spawning.** Use `execFile` or `spawn` with argument arrays only.
4. **Tests.** Pure logic goes in `src/model` or `src/shared` with `node:test` unit tests. Behaviour that touches the VS Code API goes in `test/integration`.
5. **Signed commits** and a PR for every change to `main`.
6. If you change `relay/` or `src/shared/`, run `npm run build` and commit the regenerated `claude-plugin/relay.js`.

## Layout

| Path | Contents |
|---|---|
| `relay/` | Hook command run by Claude Code (stdin → guard → snapshot → audit log) |
| `src/shared/` | Code shared by the relay and the extension: paths, audit log, blobs, guard, hook-settings merge |
| `src/model/` | Diff algorithm and the change model (pure, no VS Code dependency) |
| `src/review/` | Glue between audit events and the model; Keep/Undo |
| `src/ui/` | Decorations, CodeLens, tree, badges, baseline diff provider |
| `src/context/` | Add to Chat |
| `src/capture/` | Audit-log tailer, hook installer |
| `src/safety/` | Audit verify/export commands |
