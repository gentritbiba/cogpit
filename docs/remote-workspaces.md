# Runnable workspaces on another device

Run these commands from the local project (or a subdirectory). Every transferred
task gets its own worktree at the caller's exact HEAD plus uncommitted changes.
Work still comes back as `cogpit/<device>/<task>` through `wait` or `fetch`.

```bash
cogpit-session new "Run the app and test the change" --device omarchy
cogpit-session new "Use the target's env or fail" --device omarchy --env target
cogpit-session new "Test with my local env" --device omarchy --env caller
cogpit-session new "Lint only" --device omarchy --env none
```

| Mode | Env source | When no checkout matches |
| --- | --- | --- |
| `auto` (default) | Copy selected ignored files from the target checkout | Fresh transfer worktree, no env, explanatory note |
| `target` | Copy selected ignored files from the target checkout | Fail before sending the repo |
| `caller` | Explicitly transfer selected ignored files from the caller, even if a target checkout exists | Fresh transfer worktree with caller env |
| `none` | No env files | Fresh transfer worktree |

All four modes reuse a matching clone for Git storage when available. Copying
env files gives each agent its own editable copy: no agent writes through a link
into the shared checkout, and discard removes the copy. The main checkout's HEAD,
index, edits and env remain untouched; Cogpit adds task refs/worktrees to its Git
repository. Git ignore protections for copied paths live in its `info/exclude`.
No dependencies, build output or arbitrary ignored files travel automatically.

## Checkout discovery and identity

Discovery checks Cogpit's known project paths and retained transfer worktrees;
it does not crawl the home directory. Nested project paths resolve to their Git
root. Repository identity is the normalized, credential-free origin (`host/owner/repo`)
across HTTPS/SSH spellings. An exact origin match takes precedence. If either side
has no origin, identical root commit sets can match a local repository. Conflicting
origins do not match just because their histories share a root (forks may use
different services). Folder names are never used for matching.

Worktrees of one clone count as one project; its known main checkout is preferred.
Several matching clones are ambiguous. Auto mode uses a fresh workspace without
env; target mode fails. Select one explicitly, including a checkout that Cogpit
has not yet discovered:

```bash
cogpit-session new "Test the site" --device omarchy --env target \
  --target-checkout /home/dovahi/Work/honest-cms
```

That path must still match the caller's repository identity. A stale, missing or
wrong explicit path fails instead of borrowing another project's credentials.

`--cwd /remote/path` retains the old direct-folder behavior: no repository
transfer and no automatic branch return. Env provisioning flags require `--device`
without `--cwd`. `--worktree` also cannot combine with repository transfer.

## Selecting files

The default allowlist is `**/.env*`, `**/.dev.vars` and `**/.dev.vars.*`, including
files in packages. Dependency/cache directories (`node_modules`, `.next`,
`.venv`, `vendor`, `.cache`) are excluded. Only Git-ignored, untracked regular files qualify. Tracked
examples and nonignored files stay in the usual repository snapshot. Symlinks,
paths through symlinks outside the repository, traversal and `.git` paths are
rejected. If the caller's `.gitignore` explicitly exposes a selected env path,
provisioning fails and removes the new worktree. Limits: 100 files, 1 MiB per file, 8 MiB total binary payload.

Project configuration in `.cogpit/workspace.json`:

```json
{ "envFiles": [".env.local", "apps/web/.env*", "workers/api/.dev.vars", "config/local-secrets.json"] }
```

An explicit comma-separated allowlist overrides that configuration:

```bash
cogpit-session new "Test the Worker" --device agentbox --env caller \
  --env-files '.env.local,workers/api/.dev.vars'
```

Target modes use the target checkout's config; caller mode uses the caller's.
The configuration selects files and never opts into sending caller secrets.
Env sources are not merged: caller mode overrides the target's selection entirely.

## Reporting and secrets

`new` reports `workspace.environment` (`source`, `files`, optional `checkout` and
`note`) and `workspace.run`. CLI `status` and the HTTP session-status endpoint on either machine
report `environment` and `run`; CLI `wait` includes them alongside the result.
These details survive hub/device restarts through workspace and origin metadata.
Only paths and file names appear, never env bytes.

Caller env transfer requires a device registered with password authentication;
unauthenticated device registrations fail before reading env bytes. Env payloads
use binary framing and the existing authenticated device channel,
separately from the Git bundle. Uploads and copied files are mode 0600. Env uploads
are deleted on import success/failure; interrupted transfers have the existing
one-hour expiry. Env files are excluded from result snapshots even if staged with
`git add -f`. If an agent commits one, export refuses the result, including if a
later commit deleted it: the ancestor commit would still leak. Remove the offending
commits locally before retrying `fetch`; no secret bundle is sent back.

Do not print env contents, include them in messages, or copy secrets into code,
logs or commits. Env provisioning cannot redact output deliberately emitted by
the app or an agent. Select development credentials appropriate to the task;
separate worktrees still share whichever external services those credentials use.

`discard ID` stops the delegated session, fetches the final work and deletes the
worktree, its env copies and task metadata. A failed fetch leaves the workspace
intact for recovery; fix it and discard again. Target checkout env files are kept.

## Parallel app testing

Each provisioned workspace receives a distinct suggested `run.port` and
`run.composeProjectName`. The briefing tells the agent to run commands with:

```bash
PORT=<run.port> COMPOSE_PROJECT_NAME=<run.composeProjectName> bun run dev
COMPOSE_PROJECT_NAME=<run.composeProjectName> docker compose up -d
```

The port was available when allocated, and Cogpit does not allocate it to another
retained task. It is a hint, not a bound socket: check availability at startup and
choose another free port if an unrelated process took it. Frameworks that ignore
`PORT` need their own `--port` option. These values are instructions in the briefing,
not globally injected overrides of application env.

Keep `node_modules`, `.next`, Vite output and other mutable build caches inside
each worktree. Package-manager download caches can use their normal locking.
Compose's project name isolates generated resources; fixed `container_name`,
external volumes and hardcoded published ports still need project-specific fixes.
Stop dev servers and run `docker compose down` with the assigned project name
before discarding; Cogpit does not kill arbitrary app processes or containers.

## Compatibility and rollout

`GET /api/hello` advertises `workspaceEnvironment: 1` separately from `sessionApi`.
Absent capability: default auto and none keep today's Git-only transfer, reporting
source none with a legacy note. Explicit caller/target mode, file selections or
checkout hints fail with `DEVICE_TOO_OLD` before reading/uploading env bytes.
Session API 1 and 2 devices keep their existing session behavior. Older callers
can still use a new target through the original request/response shape.

Update the caller's Cogpit server and the target's server to this build during an
approved maintenance window. Omarchy 3.1.0/sessionApi 2 and agentbox 2.7.5/sessionApi
1 currently lack the new capability. No install, release or restart is part of
this change. After an approved rollout, check hello and run a disposable fixture
handoff before using real project env files.
