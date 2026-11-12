# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run **every** suite and ensure all tests pass — the repo has three, and none
   of the commands runs another's tests:
   - `bun run test` — Vitest, covering `src/`, `server/`, `electron/` and,
     when its submodule is checked out, the edition package in
     `editions/team/`. Test files follow the pattern `src/**/__tests__/*.test.ts`,
     `server/__tests__/**/*.test.ts`, `electron/__tests__/*.test.ts`,
     `editions/team/tests/**/*.test.ts` and `editions/team/tests/**/*.test.tsx`.
     `bun run test:public` runs the same suite as a public clone (empty
     `editions/team/`) would; a change to core must pass both.
     `bun run check:public-clone` goes further: it checks the committed HEAD
     out into a temporary worktree without the submodule and runs lint, the
     checks, both typechecks, the suite and both builds there.
   - `cd packages/cogpit-memory && bun test` — the cogpit-memory package's own
     `bun:test` suite, under `packages/cogpit-memory/src/**/__tests__/`. It has
     a separate CI step. `bun run test` at the root does **not** include it, so
     a change to `packages/cogpit-memory/` is unverified until you run this too.
   - The Rust workspace (`crates/`): `cargo fmt --all --check`,
     `cargo clippy --all-targets -- -D warnings` and `cargo test`. `bun run
     test` builds the `cogpit-core` binary first (`bun run build:core`),
     because every composition the suite boots spawns it; that needs the Rust
     toolchain from https://rustup.rs (`rust-toolchain.toml` pins it).
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

`packages/cogpit-memory`'s five sqlite-backed files — `search-index.test.ts`,
`commands/search.test.ts`, `commands/search-memory.test.ts`,
`commands/search-embeddings.test.ts` and `commands/index-cmd.test.ts` — report every test
passing and then segfault in `bun:sqlite` at teardown on Bun 1.4.0-canary.1.
That crash predates any current work and takes down a whole-package `bun test`
run, so run those five files individually to read their results.

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
in `scripts/agent-vocabulary.json` (an edition package keeps its own files'
budgets in its `agent-vocabulary.json`) that may only shrink. Going over fails, and
coming in under also fails with the new number, so a cleanup lowers its budget
in the same commit. The check measures vocabulary, not control flow. After
removing agent names from a file, re-seed with
`bun scripts/check-agents.ts --write` and commit the result.

`ARCHITECTURE.md` has the full picture, including how to add a fourth CLI.

## Editions

The edition package `@cogpit/team` is closed source, checked out as the git
submodule `editions/team/`. A public clone leaves that directory empty and must
build, test and boot without it, so "is the package here?" means
`editions/team/index.ts` exists, never the directory. Commit edition changes in
the submodule and push them there first, then commit the new submodule pointer
here; never copy edition code or docs into this repository. Core reaches edition
behavior only through `server/edition/`, whose defaults are personal-edition
behavior, and the package reaches core only through the `@cogpit/core/*` alias.
`bun run check:architecture` enforces both directions.

Edition UI lives in `editions/team/ui` and mounts only through the slots in
`src/edition/contract.ts`; a public clone renders their personal defaults.
Nothing in `src/` outside `src/edition/load.ts` names the package, and edition
UI imports core only through `@cogpit/core/src/edition/*`,
`@cogpit/core/src/components/ui/*` and `@cogpit/core/shared/*`.

`.gitmodules` sets `update = none` so a public `git clone --recurse-submodules`
does not stop at an auth prompt. With access to the package, run this once per
clone so `git submodule update` keeps checking it out:

```bash
git config submodule.editions/team.update checkout
```

`check:architecture` also refuses edition vocabulary outside the modules that
resolve and install an edition (`server/edition/{registry,resolve,load}.ts`)
and `shared/contracts/identity.ts`: no other file may compare an edition with
`"team"` or name a `/api/team/` path. Core asks the `EditionModule` hooks or
the renderer's UI slots instead.

## Adding New API Routes

Define the route module under `server/routes/` and register it once in
`server/api-routes.ts`. Vite, Electron, and standalone composition consume that
canonical ordered registry.

## Rust Core

`cogpit-core` (`crates/`, mapped in `crates/README.md`) is a loopback sidecar
the TS server supervises (`server/core/`); it runs the terminals and the file
and git routes. TS stays the front door: a route ported to Rust keeps its id
in `server/api-routes.ts`, its handler becomes `forwardToCore`, and its TS
implementation is deleted in the same change. Feature crates mount in
`crates/cogpit-core/src/routes/mod.rs`. Packaged apps pass their bundled
binary to the server as `coreBin`, never through `COGPIT_CORE_BIN`, which
every agent and terminal would inherit. See `docs/architecture/rust-core.md`.

## Desktop App

`electron/` is the desktop app on macOS, Linux and Windows. The main process
(`electron/main.ts`) runs the server in a utility process
(`electron/server-worker.ts`, Node) and loads the renderer from it; the
renderer reaches the main process only through `electron/preload.ts`
(`window.electronUpdater`, `window.electronPerformance`). electron-builder
(`electron-builder.yml`) puts `cogpit-core` in `resources/bin/` from
`core-dist/<platform>-<arch>/`, and `build/requireCore.mjs` refuses a package
without it. Updates: electron-updater on Windows and Linux, Cogpit's own
bundle swap on macOS (`electron/macBundleUpdate.ts`), both reading the
release's `latest*.yml`. `bun run electron:dev` runs it from source;
`bun run electron:update` builds this checkout and installs it over
`/Applications/Cogpit.app` (macOS). `docs/development.md` has the details.

## Releases

A `v*` tag runs `.github/workflows/release.yml`: `cogpit-core` for five
targets (`core`), the desktop app per platform with its core (`build`), the
merged and checked update manifests (`assemble`), then the GitHub release, npm
and AUR. `workflow_dispatch` on a branch dry-runs everything up to
`assemble` with the public edition and publishes nothing. The tag must equal
`package.json`'s version.

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

The package carries a prebuilt `cogpit-core` per platform in
`dist/core/<platform>-<arch>/` and starts the server on the one for the
computer it runs on. `build-npm.mjs` copies them from `COGPIT_CORE_DIST` (the
release's `core` job artifacts) or, without it, this checkout's own build.

## External Session API

Agents drive other sessions with the `cogpit-session` CLI. The server writes it
to `~/.cogpit/bin` on start (`server/sessionCli/install.ts`) and runs it with its
own runtime, so no Node is needed. Every agent Cogpit spawns gets that
directory first on PATH, plus `COGPIT_PORT` and `COGPIT_SESSION_ID`, through
`cogpitAgentEnv`. The script only forwards argv to `POST /api/session-cli`. The
commands live in `server/sessionCli/commands.ts`, so they change with the
server and the script never goes stale.

The HTTP surface it wraps, all on the local server (port from `$COGPIT_PORT`,
then `~/.cogpit/port`, then `19384`):

- `POST /api/create-and-send`: start a session (`cwd` or `dirName`, `parentSessionId` records lineage)
- `POST /api/send-message`: send a follow-up
- `GET /api/session-status/:id`: `outcome` (`running | needs_input | completed | error | not_found`) plus `waiting` requests
- `GET|POST /api/session-wait`: long-poll one or many sessions until they settle
- `POST /api/session-respond`: answer a pending permission, question or plan
- `GET /api/session-result/:id`: final reply, changed files, tokens
- `GET /api/session-children/:id`: sessions started by a session
- `POST /api/session-send`: send a follow-up without waiting for the turn

Sessions can also run on hub devices (the multi-device hub). Every command
goes through a `SessionHost` (`server/sessionHosts/`): `localHost` calls the
runtimes, and a remote host calls the same endpoints on the device via
`server/hub/deviceRequest.ts`, sending `x-cogpit-session-scope: local` so the
device answers only for itself. `hostForSession` finds a session's machine
from `session-origins.json` (parent, device, handoff, who answers its
questions), falling back to asking every device. `new --device` sends the
caller's repository (HEAD plus uncommitted work) through
`server/workspaceTransfer/` to the device's `/api/workspaces` routes as a git
worktree, then brings the work back as a local `cogpit/<device>/<task>` branch.
Questions from sessions routed to the user are collected by
`sessionHosts/delegatedRequests.ts` and shown above the parent session's
composer (`GET /api/session-requests`).

Agent-facing usage lives in the `cogpit` skill's
`.claude/skills/cogpit/references/sessions.md`.

## Cogpit Agent Skill (keep it current)

`.claude/skills/cogpit/` is the one skill that teaches agents how Cogpit works.
Cogpit embeds it in every build and refreshes it in each agent CLI's global
skills directory on launch (`server/agents/skills.ts`); it is also the
`npx skills add gentritbiba/agent-window --skill cogpit` bundle. It is layered:
`SKILL.md` is a short index, and each row points at one file in `references/`,
which may point one level deeper (`browser.md` → `browser-advanced.md`,
`devices.md` → `remote-workspaces.md`). Add a topic as a new reference and an
index row; never grow `SKILL.md` into a manual.

**Keeping this skill accurate is part of every change.** When a change alters
anything an agent running inside Cogpit can see or use (`cogpit-session`
commands or flags, `cogpit-memory`, the `agent-browser` shim, environment
variables, `~/.cogpit` paths, rendered reply syntax, panels, devices, plugins),
update the matching reference in the same commit, then run
`bun run sync-cogpit-skill`. Removed behavior comes out of the skill too.

`references/memory.md` and `references/remote-workspaces.md` are generated from
`packages/cogpit-memory/skill/SKILL.md` and `docs/remote-workspaces.md`; edit
those sources. The sync script also regenerates `server/agents/bundledSkills.ts`,
and `check:cogpit-skill-sync` fails CI on drift.

## Nested iOS Repository

The `ios/` directory is a separate, private Git repository that is intentionally ignored by this parent repository. When changing anything under `ios/`, run Git commands from `ios/` and commit and push those changes to the child repository. Never stage iOS files in the parent repository, and always report the status of both repositories when a task touches both.

## Browser Panel

Live agent-browser streaming inside the workspace (see `docs/browser.md`). The bash shim at `~/.cogpit/bin/agent-browser` owns `--profile`, `--args`, and socket directories — never set them elsewhere or in `server/browser/daemons.ts`. Shared types live in `shared/browser/types.ts`; keep the client and server in sync there only. Cogpit prepends the shim to agent PATHs. Single-session processes receive `COGPIT_SESSION_ID`; shared processes start without an owner, with thread configuration supplying an id where supported. The shim routes to persistent profiles (`default`, named) or throwaway trees (`tmp-*`). With accounts the server leaves it notes under `~/.cogpit/browser/owners/` (`server/browser/owners.ts`) so an agent's `default` opens its session owner's own profile, and `server/browser/access.ts` decides per browser who may watch, drive or own it. The panel attaches via CDP over a second WebSocket and supports remote devices through the hub.

## Showing Images and Videos

The timeline renders markdown image syntax inline, and the same syntax plays
videos: `![alt](/absolute/path.png)` or `![alt](/absolute/path.webm)`.
Images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico`, `avif`) open
in the zoomable viewer; videos (`mp4`, `m4v`, `webm`, `mov`) play with controls
and seeking. Local paths go through `/api/local-file`, which the Rust core
serves with byte ranges for video. `shared/mediaTypes.json` is the one list of
extensions and MIME types: the renderer reads it through
`shared/mediaTypes.ts` and the core compiles it in. Remote `https://` media is blocked by the app's CSP.
When you have a screenshot or recording to show, put the `![alt](src)` line in
the message you write. A tool result that displays it to you does not display it
to the user. Show milestones and evidence, not every step.
