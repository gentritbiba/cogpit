# Rust core (stage A)

Cogpit's server is moving the parts that port cleanly to Rust, one route group
at a time. Each port deletes the TypeScript it replaces in the same change, so
there is never a second implementation to keep in step. Nothing user-visible
changes.

## Shape

```
renderer / iOS / hub ──HTTP+WS──> TS server (front door)
                                     │ ported routes and sockets are forwarded
                                     ▼
                              cogpit-core (Rust sidecar, axum + tokio)
                              127.0.0.1:<ephemeral>, per-boot secret
```

The TS server stays the front door. `server/security.ts`, `authMiddleware`,
`editionAuthz`, the route registry in `server/api-routes.ts` and the team
edition's route policies are unchanged by a port: a ported route keeps its id
and its TS handler shrinks to a forward. Core never authenticates and never
calls back into TS. Anything it needs from the agent layer or the edition, TS
resolves before forwarding.

## The sidecar

`crates/cogpit-core` is the binary; `crates/core-protocol` is the contract both
sides read.

1. TS spawns the binary with `windowsHide` and writes one JSON line to its
   stdin: `{"secret": …, "config": {"dataDir": …}}` (`BootMessage`, with
   `AppConfig`). Neither the secret nor the config goes through argv or the
   environment, where other local processes can read them.
2. Core binds `127.0.0.1:0` and prints one line to stdout:
   `{"port": …, "version": …, "protocol": 1}`. A protocol mismatch makes TS
   refuse the binary and ask for `bun run build:core`.
3. Every request must carry `x-cogpit-core-secret`; anything else gets 401.
   `x-cogpit-principal` names the caller TS authorized, for core's logs only.
4. TS keeps core's stdin open. When it closes, because TS stopped it or died,
   core finishes open requests for up to two seconds and exits. This works the
   same on Windows, where there is no parent-death signal. Core ignores Ctrl+C:
   a terminal sends it to the whole process group, and TS decides when core
   stops.

Core always serves `GET /v1/health` and the transport self-test routes under
`/v1/diag/` (HTTP echo, drain, WebSocket echo). The TS forwarder and relay are
tested against those on the real binary. Logs go to stderr, which TS prints
with a `[cogpit-core]` prefix; `COGPIT_CORE_LOG` sets the filter (default
`warn`).

## Supervisor (`server/core/`)

One process-wide supervisor, like `processRegistry`. Every composition takes a
lease with `startCore()`: `createServerComposition` (the desktop sidecar, the
standalone server, the npm launcher, test fixtures) and both Vite dev plugins.
The first lease starts core and the last release stops it, closing stdin and
killing it two seconds later if it is still there.

The binary is, in order: `COGPIT_CORE_BIN`; the shell's packaged path
(`AppServerEnvironment.coreBin`); the newest of `target/{debug,release}` in the
Cargo workspace above the server code (or under `CARGO_TARGET_DIR`). Server
code runs from the source tree and the npm bundle (the desktop app passes its
bundled binary as `coreBin`), so the workspace is found by walking up from the module rather than by a fixed
relative path. No binary is a startup error that says how to build one.

After boot it health-checks core. If core exits unexpectedly it restarts with
backoff (200 ms doubling to 10 s, reset after 30 s of stable running).
Forwarded requests wait up to ten seconds for a restart, then answer 503.

## Forwarding

- `forwardToCore(req, res, corePath)` sends the request to `corePath` with the
  client's query string. Express and Vite strip a route's mount prefix from
  `req.url`, so the query comes from `req.originalUrl`. Bodies stream both
  ways, keeping the body's framing (a chunked body stays chunked on any
  method; a request without one sends none). Hop-by-hop headers, cookies, `authorization` and any client-sent core
  headers are dropped; the secret and principal are added. Requests reuse
  kept-alive connections to core, and core sets `TCP_NODELAY` on each.
- `bodySizeLimit` applies to every request that carries a body, whatever the
  method, and counts the body as it is piped to core. A declared length
  over the limit is refused before forwarding. A chunked body that grows past
  it gets the limit's own 413 while core has not answered yet (upload routes
  read the whole body first); if core has already started streaming a
  response, the limit cuts the connection instead of throwing.
- That cut, and the core request the forwarder abandons after it or after the
  client leaves, close in stages (`closeInStages`): a FIN first, then destroy
  once the peer has closed its side or after 2 s. `destroy()` with unread data
  pending is a TCP reset, and macOS loopback can lose one sent right after our
  own writes to a peer with nothing left to send, which then waits forever:
  the client for the rest of its response, core for the rest of the body.
  While it abandons a request the forwarder also reads and drops what core
  still sends, because core only looks for the end of a request while it can
  write.
- `relayToCore(ws, req, corePath)` relays a WebSocket TS has already accepted
  and authorized, frame for frame, with text and binary preserved. Frames sent
  before core connects are buffered (4 MiB at most). Core's close code reaches
  the client; `relay.close(code, reason)` lets TS close the client with its own
  code, such as 1008 when `PtyAuthorizationController` revokes a session.
  Optional hooks run on every frame in flight: `toCore` may rewrite or drop a
  client frame (buffered frames included), and `toClient` may drop a core
  frame. A hook that throws closes the client with 1011.

`attachSocketTransports(httpServer, { fallback })` (`server/socketTransports.ts`)
is the one upgrade handler: hub proxy, `/__pty`, `/__browser`, then the
fallback (Vite's HMR proxy in the composition; nothing in the Vite plugin,
where Vite's own listener answers HMR).

## Adding a feature crate

A crate under `crates/` exposes `pub fn router(state) -> axum::Router` with
its own state type, built from `core_protocol::AppConfig`, and owns no auth.
Mount it with one line in `crates/cogpit-core/src/routes/mod.rs`, under
`/v1/<area>`. On the TS side, keep the route's id in `server/api-routes.ts`,
replace its handler with `forwardToCore`, and delete the TS implementation.

## Ported routes

| Route ids | Core crate, mount | Notes |
| --- | --- | --- |
| `local-file`, `file-content`, `project-files` (and `/tree`), `project-file`, `git-status`, `git-diff` | `crates/core-files`, `/v1/files` | Shell out to `git`. Node's `path` rules (posix and win32), `realpath` shape and `localeCompare` order are reproduced so responses match the old TS routes byte for byte. `server/lib/gitProject.ts` (`resolveGitProject`, `runGit`) stays in TS for the GitHub and Cloudflare plugins, PR review and `projectRoot.ts`; the core has its own copy in `crates/core-files/src/git.rs`, an accepted duplication until those callers port. On macOS, when `git` on PATH is the Xcode shim `/usr/bin/git` (about 6 ms per run spent finding the developer directory), core asks `xcrun --find git` once and runs that git directly. Each request does its filesystem work in one trip to the blocking pool; media ranges up to 1 MiB are read whole, longer ones stream. JSON and text over 1 KiB gzip in core (zlib-rs, level 6, the same bytes Bun's `zlib.gzip` writes), since TS pipes forwarded responses through untouched. |
| `/__pty` (WebSocket) | `crates/core-pty`, `/v1/pty/ws` | `/__pty` still ends at TS. `server/pty-socket.ts` relays each connection with `relayToCore`, checks `PtyAuthorizationController`'s authorizer on every frame both ways (plus a 5 s recheck, closing with 1008), and turns a `spawn` naming an agent's sign-in into a plain `command`/`args`/`env` spawn built by `agentSignInLaunch`. |

Known differences from the TS routes:

- File listings always sort with the root collation, which is what Bun's
  `localeCompare` uses; every shell runs the TS server on Bun. The old
  Electron shell ran it on Node, whose order followed the system language, so
  a user upgrading from it with a tailored locale (Swedish, Danish, Czech, …)
  can see a different order.
- A `project-file` save body that `JSON.parse` accepts but serde_json does not
  gets 500 "Unable to access project file", where TS answered 400 or saved
  the file: a number that overflows to Infinity, an escaped lone surrogate or
  invalid UTF-8 bytes (TS saved them as U+FFFD), JSON nested deeper than 128
  levels. The app's editor never sends these.

`core-pty` runs processes on `portable-pty` on Unix (the shell leads its own
session with the PTY as its controlling terminal) and on ConPTY directly on
Windows, where `cmd.exe` needs its `/c` line verbatim. Killing a terminal, and
stopping the core (stdin closed), ends each running shell the way the TS server
did: SIGHUP on Unix, `taskkill /T /F` on Windows, which ends the shell's tree by
parent and spares a program whose launcher already exited (an editor opened
with `code .`). A job object holds each Windows terminal's processes only as
the backstop for a core that dies without stopping them.

One thread (`pty-io`) reads and writes every terminal, non-blocking. A blocking
reader thread per terminal contends in the kernel on macOS: eight terminals
printing at once cost five times the CPU of one thread reading all eight.
Output reaches clients in batches, sent when a batch reaches 64 KiB, when a
read comes back shorter than 1 KiB (so a keystroke's echo goes at once) or
3 ms after the batch began; each batch is serialized once, on the connection
that sends it first. Windows pipes have no readiness to wait on, so there a
thread per terminal reads the output and another writes the input, both
handing over to `pty-io`. The Windows module
(`backend/windows.rs`) is the workspace's one exception to
`unsafe_code = "forbid"`; every unsafe block states its invariant, and a test
keeps unsafe code out of every other file.

## Not ported in stage A

| What | Why |
| --- | --- |
| Transcript parsing | The renderer parses transcripts itself and cogpit-memory copies that code. A Rust parser on the server would be a second one. Stage B candidate: one Rust parser compiled to WASM for the renderer and native for the server and CLI. |
| Agent runtimes, orchestration dispatcher, stream bus, session CLI | They share in-process state with the dispatcher and its queues, and port with it. |
| Driving Claude | `@anthropic-ai/claude-agent-sdk` exists only for TypeScript. |
| `files-watch` | It is the live transcript stream, built on the stream bus and edition authorization. |
| Auth, the hub proxy, the session catalog | Stage B, once stage A has proven the sidecar. |
| The React UI | It stays React. |

## Building and testing

`bun run build:core` builds the debug binary (`--release` for release); `dev`,
`desktop:dev`, `test` and `serve` run it first (`desktop:build` builds and ships
the release binary), and cargo makes repeat builds
nearly free. The Rust gates are `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings` and `cargo test`. CI runs them in a
separate Linux job (and `cargo test` on one Windows shard), and builds the core
before the Vitest suites on Linux and Windows.
`check:public-clone` shares this checkout's `CARGO_TARGET_DIR` with its
temporary worktree.

Packaged desktop builds and the npm launcher do not ship the binary yet; that
is the packaging step that follows (set `COGPIT_CORE_BIN` to run one today).
