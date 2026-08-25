# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run `bun run test` and ensure all tests pass
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

Test files follow the pattern `src/**/__tests__/*.test.ts`, `server/__tests__/**/*.test.ts`, and `electron/__tests__/*.test.ts`.

## Adding New API Routes

Define the route module under `server/routes/` and register it once in
`server/api-routes.ts`. Vite, Electron, and standalone composition consume that
canonical ordered registry.

## App Icon

`public/cogpit.svg` is the only source of truth for the app mark. Never hand-edit
the raster icons — change the SVG, then run `bun run generate:icons`, which
re-renders all of them:

- `build/icon.png` / `.icns` / `.ico` — picked up by electron-builder via `directories.buildResources`
- `public/apple-touch-icon.png` — iOS "Add to Home Screen"
- `ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png` — native iOS app icon

The generator needs librsvg (`brew install librsvg`); `.icns` also needs macOS.
The SVG's `<rect id="bg" … rx="…">` is load-bearing: the script strips `rx` to
produce the full-bleed, alpha-free variants that Apple requires, since iOS
applies its own squircle mask.

## External Session API (cogpit-sessions skill)

Other agents can create and manage Claude Code sessions via the HTTP API on `localhost:19384`. The packaged app binds an ephemeral port unless network access pins 19384, so resolve the port from `$COGPIT_PORT`, then `~/.cogpit/port` (written on start, removed on exit), then `19384`. Key endpoints:

- `POST /api/create-and-send` — Start a new session with a message (responds in 5–15s)
- `POST /api/send-message` — Send follow-up (returns immediately when the session is live; poll session-status for completion)
- `GET /api/session-status/:sessionId` — Poll turn status (`running: false` = turn done)
- `POST /api/stop-session` — Stop a running session
- `GET /api/projects` — List available projects and their `dirName`s
- `GET /api/session-context/:sessionId` — Read session output as parsed turns
- `GET /api/sessions/:dirName/:fileName` — Read raw session JSONL

See the `cogpit-sessions` skill (`.claude/skills/cogpit-sessions/SKILL.md`) for full usage, timeouts, and permissions.

## Nested iOS Repository

The `ios/` directory is a separate, private Git repository that is intentionally ignored by this parent repository. When changing anything under `ios/`, run Git commands from `ios/` and commit and push those changes to the child repository. Never stage iOS files in the parent repository, and always report the status of both repositories when a task touches both.
