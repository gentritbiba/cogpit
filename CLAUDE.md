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

## External Session API (cogpit-sessions skill)

Other agents can create and manage Claude Code sessions via the HTTP API on `localhost:19384`. Key endpoints:

- `POST /api/create-and-send` — Start a new session with a message (responds in 5–15s)
- `POST /api/send-message` — Send follow-up to an existing session (waits for full turn)
- `POST /api/stop-session` — Stop a running session
- `GET /api/projects` — List available projects and their `dirName`s
- `GET /api/sessions/:dirName/:fileName` — Read session output

See the `cogpit-sessions` skill (`.claude/skills/cogpit-sessions/SKILL.md`) for full usage, timeouts, and permissions.

<!-- gitnexus:start -->
# GitNexus — Risk-Based Code Intelligence

GitNexus is available for understanding call chains, execution flows, and change impact. Use it when the extra graph context materially reduces risk:

- architectural or cross-module changes
- shared APIs and core runtime paths
- security-sensitive work
- unfamiliar code with unclear downstream consumers
- broad refactors or coordinated renames

It is optional for isolated syntax fixes, tests, documentation, styling, and clearly local edits. Do not add analysis overhead when the blast radius is already obvious from the code.

When GitNexus reports HIGH or CRITICAL risk, tell the user before proceeding and verify the affected flows. Run `detect_changes` before large commits or releases. If the index is stale, run `npx gitnexus analyze`.

Relevant guides live under `.claude/skills/gitnexus/`:

- `exploring/SKILL.md`
- `debugging/SKILL.md`
- `impact-analysis/SKILL.md`
- `refactoring/SKILL.md`

<!-- gitnexus:end -->
