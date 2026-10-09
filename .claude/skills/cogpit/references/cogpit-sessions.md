<!-- Generated from .claude/skills/cogpit-sessions/SKILL.md by scripts/sync-cogpit-skill.ts. Edit the source, then run `bun run sync-cogpit-skill`. -->

# Cogpit sessions

Use `cogpit-session`; it is on PATH inside Cogpit. Outside Cogpit, use
`~/.cogpit/bin/cogpit-session`. The server must be running. Run
`cogpit-session help` for flags and advanced commands.

Cogpit sets `COGPIT_SESSION_ID` and `COGPIT_PORT`. Keep them: new sessions are
recorded as your children, and commands go to your local server.

## Start and collect

```bash
cogpit-session new "Fix the parser and report what changed" --wait --timeout 90
```

For independent tasks, start children without `--wait`, save each returned
`sessionId`, then wait on them together. Use distinct `--worktree NAME` values
when children will edit the same repository.

```bash
A=$(cogpit-session new "Fix the parser" --worktree parser | jq -r .sessionId)
B=$(cogpit-session new "Fix the renderer" --worktree renderer | jq -r .sessionId)
cogpit-session wait "$A" "$B" --timeout 90
cogpit-session children
```

`--cwd DIR` chooses a project. `--agent`, `--instance`, `--model`, `--effort`
and `--name` select how it runs. Long prompts can come from stdin:
`cogpit-session new - --wait < task.md`.

Default CLI accounts use `bypassPermissions`; configured provider instances
and ACP default to supervised mode. Use `--mode default` when approval is needed.
A skill does not grant permission beyond the user's task.

## Follow up and inspect

```bash
cogpit-session send "$ID" "Now add a regression test" --command-id parser-tests-001
cogpit-session receipt parser-tests-001 --session "$ID" --wait --timeout 90
cogpit-session wait "$ID" --timeout 90
cogpit-session status "$ID"
cogpit-session result "$ID" --text
```

`send --wait` waits for its delivery receipt; `wait` returns the session's final
reply and changed files. Reuse the same command ID and message after a lost
response. `queued` means accepted, not finished. For `unknown` delivery, inspect
native history before reconciling; do not resend blindly. `held` needs queue review.
Use `--steer` to join a supported running turn, or `--interrupt` to restart it.

Timeout leaves the child running. Continue with `wait`; do not spawn a duplicate.
Eventual completion is saved and notifies the parent. Read it with
`cogpit-session tasks`, then acknowledge it with `tasks --ack TASK_ID`.
A successful `new --wait` already acknowledges its result.

| Exit | Meaning |
| --- | --- |
| 0 | Completed successfully |
| 2 | Needs an answer or approval; inspect `waiting` and `next` |
| 3 | Still running or timed out; keep waiting |
| 1 | Error, missing session or unreachable device; inspect the response |

## Another computer

```bash
cogpit-session devices
cogpit-session new "Run the Linux checks and report findings" --device Omarchy --wait --timeout 90
```

The device must be registered, reachable and authenticated, with its agent
installed and signed in. Basic remote control needs `sessionApi: 1`; durable
follow-ups, answers and provider handoffs need `sessionApi: 2`. Update an old device.

Without `--cwd`, Cogpit sends your Git repository's HEAD plus staged, unstaged
and non-ignored new files into an isolated remote worktree. Capable devices
reuse a matching target checkout and copy its ignored env files by default;
caller secrets never travel automatically. Install dependencies in the worktree.
Git submodule contents and LFS objects are not bundled. Repository transfer
requires host-wide/admin access.

Choose `--env target` to require the target's env, `--env caller` to explicitly
send your ignored env, or `--env none` for Git-only work. Default `auto` uses
target env when one checkout matches, otherwise none. Use `--target-checkout`
to select an ambiguous checkout; `--env-files` overrides the file allowlist.
These options require `--device` without `--cwd` and `workspaceEnvironment: 1`;
old devices retain Git-only auto/none. Caller env needs authenticated registration.

`new`, `status` and `wait` report the env source and file names, never contents.
Use the briefing's `PORT` and `COMPOSE_PROJECT_NAME` for parallel tests. Env copies
are private and removed on discard; never print or commit secrets. Read
`references/remote-workspaces.md` for matching, selection, safety and rollout.

`wait` on completion or `fetch ID` returns work to `cogpit/<device>/<task>`;
inspect `returned`, `returnError` and the review/apply instructions. Your working
files are not automatically merged. Async result notifications do not fetch files.
`--cwd /absolute/remote/path` uses an existing remote folder instead, with no
repository transfer or automatic file return. `projects --device NAME` lists folders.

IDs route automatically for `send`, `wait`, `status`, `result`, answers and stops.
Remote requests go to the user in Cogpit by default. Use `--questions agent` to
handle them yourself; local children default to agent handling.

## Answer and clean up

```bash
cogpit-session approve "$ID" --request "$REQUEST"
cogpit-session deny "$ID" --request "$REQUEST" --feedback "Use the smaller change"
cogpit-session answer "$ID" "Blue" --request "$REQUEST"
cogpit-session interrupt "$ID"   # stop the turn, retain the session
cogpit-session stop "$ID"        # stop the session
cogpit-session discard "$ID"     # fetch remote work once more, then remove its worktree
```

Omit `--request` when exactly one matching request is pending. After answering,
wait again. Stop only children you own. `stop` keeps a transferred worktree;
`discard` removes it after preserving its work. For full transcript drill-down,
use `cogpit-memory`.
