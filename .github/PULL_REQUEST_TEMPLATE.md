## What and why

<!-- What does this change, and why? Link an issue if there is one. -->

## Checklist

- [ ] `npm run check` passes (typecheck, build, no-network check, unit tests)
- [ ] `npm run test:integration` passes for changes that touch the VS Code API
- [ ] No new runtime dependencies, no network code, no shell spawning (see CONTRIBUTING.md)
- [ ] If `relay/` or `src/shared/` changed, I ran `npm run build` and committed `claude-plugin/relay.js`
- [ ] Docs / CHANGELOG updated where relevant
