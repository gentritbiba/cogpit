# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run `bun run test` and ensure all tests pass
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

Test files follow the pattern `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`.

## Adding New API Routes

Define the route module under `server/routes/` and register it once in
`server/api-routes.ts`. Vite, Electron, and standalone composition consume that
canonical ordered registry.

## External Session API (cogpit-sessions skill)

Other agents can create and manage Claude Code sessions via the HTTP API on `localhost:19384`. Key endpoints:

- `POST /api/create-and-send` — Start a new session with a message (responds in 5–15s)
- `POST /api/send-message` — Send follow-up to an existing session (waits for full turn)
- `POST /api/stop-session` — Stop a running session
- `GET /api/projects` — List available projects and their `dirName`s
- `GET /api/sessions/:dirName/:fileName` — Read session output

See the `cogpit-sessions` skill (`.claude/skills/cogpit-sessions/SKILL.md`) for full usage, timeouts, and permissions.

## Nested iOS Repository

The `ios/` directory is a separate, private Git repository that is intentionally ignored by this parent repository. When changing anything under `ios/`, run Git commands from `ios/` and commit and push those changes to the child repository. Never stage iOS files in the parent repository, and always report the status of both repositories when a task touches both.
