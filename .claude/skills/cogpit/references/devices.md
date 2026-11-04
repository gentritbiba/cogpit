# Sessions on another computer

Start and drive children with the commands in [sessions.md](sessions.md); this
page covers what changes when the child runs on a registered Cogpit device.

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
[remote-workspaces.md](remote-workspaces.md) for matching, selection, safety and rollout.

`wait` on completion or `fetch ID` returns work to `cogpit/<device>/<task>`;
inspect `returned`, `returnError` and the review/apply instructions. Your working
files are not automatically merged. Async result notifications do not fetch files.
`--cwd /absolute/remote/path` uses an existing remote folder instead, with no
repository transfer or automatic file return. `projects --device NAME` lists folders.

IDs route automatically for `send`, `wait`, `status`, `result`, answers and stops.
Remote requests go to the user in Cogpit by default. Use `--questions agent` to
handle them yourself; local children default to agent handling.

