# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run `bun run test` and ensure all tests pass
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

Test files follow the pattern `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`.

## Adding New API Routes

Every new route must be registered in **both** places:

1. `server/api-plugin.ts` — Vite dev server (used during `bun run dev`)
2. `electron/server.ts` — Electron/production Express server (e.g. port 19384)

Registering in only one means the route works in dev but not in the built app, or vice versa.
