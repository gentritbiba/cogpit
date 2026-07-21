## What changed

<!-- Describe the user-visible outcome and why this change is needed. -->

## Architecture and risk

- [ ] New code follows the dependency rules in `docs/architecture/README.md`.
- [ ] API route additions use the canonical registry in `server/api-routes.ts`.
- [ ] Shared/session contract changes preserve app and `cogpit-memory` parity.
- [ ] Security boundaries, persisted formats, migrations, and rollback risks are described below, or are not affected.

<!-- Note meaningful tradeoffs, compatibility seams, and follow-up debt. -->

## Verification

- [ ] `bun run lint`
- [ ] `bun run check:architecture`
- [ ] `bun run check:duplicates`
- [ ] `bun run check:audit`
- [ ] `bun run check:cogpit-memory-sync`
- [ ] `bun run typecheck && bun run typecheck:tests`
- [ ] `bun run test:coverage`
- [ ] Relevant web, Electron, server, and package contract checks pass.

<!-- Include focused manual/QA evidence for behavior that automated tests cannot prove. -->
