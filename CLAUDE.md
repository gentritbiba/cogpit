# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run **both** suites and ensure all tests pass — the repo has two, and neither
   command runs the other's tests:
   - `bun run test` — Vitest, covering `src/`, `server/` and `electron/` only.
     Test files follow the pattern `src/**/__tests__/*.test.ts`,
     `server/__tests__/**/*.test.ts` and `electron/__tests__/*.test.ts`.
   - `cd packages/cogpit-memory && bun test` — the cogpit-memory package's own
     `bun:test` suite, under `packages/cogpit-memory/src/**/__tests__/`. It has
     a separate CI step. `bun run test` at the root does **not** include it, so
     a change to `packages/cogpit-memory/` is unverified until you run this too.
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

`packages/cogpit-memory`'s three sqlite-backed files — `search-index.test.ts`,
`commands/search.test.ts` and `commands/index-cmd.test.ts` — report every test
passing and then segfault in `bun:sqlite` at teardown on Bun 1.4.0-canary.1.
That crash predates any current work and takes down a whole-package `bun test`
run, so run those three files individually to read their results.

## Agent Layer

Cogpit drives three agent CLIs. New agent-specific knowledge belongs in
`server/agents/`, `src/lib/agents/` and the `shared/session/` agent modules.

Everything else asks the layer instead: `descriptorFor(kind)` /
`descriptorForDirName(dirName)` for facts and capabilities, `formatFor()` for
transcript grammar, `storeFor()` for files on disk, `runtimeFor()` for the live
process. If a feature needs a fourth arm, the missing piece is a capability flag
or a descriptor field — add it there.

`bun run check:agents` prevents agent names from spreading while older call
sites are migrated. Files outside the agent layer carry a per-file line budget
in `scripts/agent-vocabulary.json` that may only shrink. Going over fails, and
coming in under also fails with the new number, so a cleanup lowers its budget
in the same commit. The check measures vocabulary, not control flow. After
removing agent names from a file, re-seed with
`bun scripts/check-agents.ts --write` and commit the result.

`ARCHITECTURE.md` has the full picture, including how to add a fourth CLI.

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

## cogpit-memory Distribution

`packages/cogpit-memory/` is the source of truth and ships to two places, both
automatically:

- **npm** (`cogpit-memory`) — `release.yml` publishes it on `v*` tags using the
  version in its own `package.json`, not the tag, so it keeps a version line
  independent of the app's. Bump that version when you want a release; the step
  no-ops on tags where npm already has it.
- **github.com/gentritbiba/cogpit-memory** — the standalone repo backing
  `npx skills add gentritbiba/cogpit-memory`. `mirror-cogpit-memory.yml` replays
  the package directory there on every master push that touches it.

Never commit to the mirror directly — it is cleared and rewritten from this repo,
so anything landed there is lost on the next sync. The push needs the
`COGPIT_MEMORY_DEPLOY_KEY` secret, a write-scoped deploy key on that repo.

## Cogpit npm launcher

`packages/cogpit-cli/` publishes as `cogpit`. On a `v*` tag,
`.github/workflows/release.yml` stamps the package version from the tag before
running its tests, package-contract build and `npm publish`. The release commit
does not need to keep `packages/cogpit-cli/package.json` synchronized with the
app version. The tag is the source of truth for the published launcher.

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
