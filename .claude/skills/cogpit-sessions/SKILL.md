---
name: cogpit-sessions
description: Start, message, wait on, answer and stop Claude Code, Codex and Copilot sessions through Cogpit with the cogpit-session CLI (or its HTTP API on localhost). Use when an agent needs to delegate work to another session, fan work out to several sessions and collect the results, approve or answer what a session is blocked on, read what a session did, or stop the sessions it started.
---

# Driving other sessions with Cogpit

Use the `cogpit-session` CLI. It resolves the server, retries safely, blocks
until a session is done, and prints JSON with the final reply. You rarely need
the HTTP API below.

## Where the CLI is

- **Inside a session Cogpit started:** `cogpit-session` is on your PATH, and
  `COGPIT_PORT` and `COGPIT_SESSION_ID` are set. Sessions you create are
  recorded as your children.
- **Anywhere else on the same machine:** run `~/.cogpit/bin/cogpit-session`.
  Cogpit rewrites it on every start. It finds the server through
  `$COGPIT_PORT`, then `~/.cogpit/port`, then `19384`.
- Run `cogpit-session help` for the full usage.

## Delegate and wait

```bash
cogpit-session new "Fix the failing tests in src/parser and summarize the cause" --wait --timeout 300
```

```json
{ "sessionId": "…", "outcome": "completed", "reply": "Fixed: …", "filesChanged": [{ "path": "…", "type": "edit", "additions": 4, "deletions": 1 }] }
```

- The session runs in your working directory. Use `--cwd DIR` for another
  project and `--worktree NAME` to isolate its edits in a git worktree.
- `--agent claude|codex|copilot`, `--model`, `--effort` and `--name` pick how
  it runs.
- A long message can come from stdin: `cogpit-session new - --wait < task.md`.
- **Permissions:** new sessions run with `--mode bypassPermissions` so nothing
  stalls. Pass `--mode default` (or `acceptEdits`, `plan`) to supervise it
  yourself instead (see "Answering a blocked session").

Follow up in the same session, which keeps its context:

```bash
cogpit-session send "$ID" "Now add a regression test" --wait
cogpit-session send "$ID" "Stop, use the other approach" --interrupt   # cut the current turn first
```

## Outcomes and exit codes

Every report carries an `outcome`:

| outcome | meaning | exit code |
| --- | --- | --- |
| `completed` | turn finished; `reply` and `filesChanged` are included | 0 |
| `needs_input` | blocked on a permission prompt, question or plan; see `waiting` and `next` | 2 |
| `running` | still working when `--timeout` ran out; run the `next` command to keep waiting | 3 |
| `error` | the turn failed; see `error` | 1 |
| `not_found` | no such session | 1 |

`wait` defaults to a 90-second timeout, below the two-minute limit of most
shell tools. For longer work, pass a larger `--timeout` (and raise your shell
tool's timeout to match), or wait in a loop:

```bash
until cogpit-session wait "$ID" --timeout 90 > /tmp/report.json; [ $? -ne 3 ]; do :; done
cat /tmp/report.json
```

A session whose turn ended while background agents still run stays `running`
until it finishes for real.

## Fan out, then collect

```bash
A=$(cogpit-session new "Audit the API routes for missing auth" --worktree audit-api | jq -r .sessionId)
B=$(cogpit-session new "Audit the React forms for XSS" --worktree audit-ui | jq -r .sessionId)
cogpit-session wait "$A" "$B" --timeout 600      # all of them; add --any to return on the first
cogpit-session children                          # everything you started, with its outcome
```

`new` returns as soon as the session exists (5–15 s) unless you pass `--wait`.

## Answering a blocked session

When `outcome` is `needs_input`, `waiting` lists each request, and `next`
lists the command that answers it:

```json
{
  "outcome": "needs_input",
  "waiting": [{ "kind": "permission", "requestId": "toolu_…", "toolName": "Bash", "summary": "rm -rf build", "availableDecisions": ["allow", "allow_always", "deny"] }],
  "next": ["cogpit-session approve ID --request toolu_…  |  cogpit-session deny ID --request toolu_…"]
}
```

```bash
cogpit-session approve "$ID"                    # the only pending permission or plan
cogpit-session approve "$ID" --always           # also allow it for the rest of the session
cogpit-session deny "$ID" --request REQ         # pick one when several are pending
cogpit-session deny "$ID" --feedback "Smaller steps please"   # reject a plan with feedback
cogpit-session answer "$ID" "Blue"              # a question: one answer per question, in order
cogpit-session answer "$ID" --json '{"Which color?":"Blue"}'
```

Then `wait` again. `--request` is optional when exactly one matching request is
pending.

## Reading and cleaning up

```bash
cogpit-session status "$ID"          # outcome, current tool, anything blocking it
cogpit-session result "$ID"          # reply of the last turn, files changed, tokens
cogpit-session result "$ID" --turn 0 --text   # just the reply text of turn 0
cogpit-session interrupt "$ID"       # stop the turn, keep the session
cogpit-session stop "$ID"            # end it
cogpit-session stop --children       # end every session you started
```

For full turns, tool calls and subagents, read the transcript with
`GET /api/session-context/:sessionId` (below) or the cogpit-memory CLI.

## HTTP API

Use the API when you cannot run a shell command. All endpoints take and return
JSON. Requests from 127.0.0.1/::1 skip authentication.

```bash
PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"
BASE="http://localhost:$PORT"
```

### POST /api/create-and-send

Creates a session and sends the first message. Responds in 5–15 s, once the
transcript exists; use `--max-time 30`.

```json
{
  "cwd": "/abs/project (or dirName)",
  "dirName": "project dirName from /api/projects (or cwd)",
  "agent": "claude | codex | copilot (only with cwd; default claude)",
  "message": "string (required unless images)",
  "images": [{ "data": "base64", "mediaType": "image/png" }],
  "permissions": { "mode": "bypassPermissions" },
  "model": "string ('' = provider default; GET /api/models lists options)",
  "effort": "low | medium | high | xhigh | max",
  "fastMode": false,
  "ultracode": false,
  "worktreeName": "run in a git worktree with this name",
  "mcpConfig": "JSON-encoded mcpServers config",
  "name": "session title",
  "parentSessionId": "your own session id, to list it later as your child",
  "requestId": "8–128 of [A-Za-z0-9_-]; reuse on retries"
}
```

Response: `{ success, requestId?, dirName, fileName, sessionId, initialContent? }`.

- **Always pass `permissions.mode`.** The server default, `default`, gates each
  tool call on an approval. Nothing answers it unless you do (see
  `/api/session-respond`). `bypassPermissions` runs everything. The old
  `{ "allow", "deny" }` shape is silently ignored.
- **Retries:** keep one `requestId` per intended session and resend the same
  payload after a timeout or dropped connection. The server returns the
  original session instead of starting another. `409 CONFLICT` means the ID
  was reused with a different payload, or the outcome is still unknown. Do not
  start a new copy blindly. The CLI does this for you.
- A Claude `dirName` is the path with every non-alphanumeric character replaced
  by `-`; Codex and Copilot use their own prefixes. Prefer `cwd`.

### POST /api/send-message

`{ sessionId, message, images?, permissions?, model?, effort?, fastMode?, ultracode?, mcpConfig?, cwd? }`

Returns `{ success: true }` right away when the session is live. When the
session has to be resumed, the response waits for the whole turn. Either way,
wait with `/api/session-wait` afterwards.

### GET /api/session-wait/:sessionId?timeout=90 · POST /api/session-wait

Long-polls until the session settles (`outcome` other than `running`) or the
timeout (seconds, default 90, max 3600) passes. The GET form returns
`{ timedOut, ...state }`. The POST form waits on several sessions:
`{ "sessionIds": [...], "mode": "all" | "any", "timeout": 600 }` →
`{ timedOut, sessions: [state...] }`.

### GET /api/session-status/:sessionId

The same `state` without waiting:

```json
{ "sessionId": "…", "outcome": "running", "live": true, "running": true, "status": "tool_use", "toolName": "Bash", "waiting": [], "pendingQueue": 0 }
```

- `outcome`: `running | needs_input | completed | error | not_found` (404).
- `waiting`: pending requests: `{ kind: "permission", requestId, toolName, summary, availableDecisions }`,
  `{ kind: "question", requestId, questions: [{ question, multiSelect, options }] }`,
  `{ kind: "plan", requestId, summary, actions, recommendedAction }`.
- `running`: a turn is in flight. `live`: a connection is held that takes follow-ups without a resume.
- `status`: the transcript tail (`idle | thinking | tool_use | processing | completed | compacting | deferred | awaiting_agents`), plus `terminalReason`, `pendingAgents` and `pendingAgentDescriptions` when they apply.
- `error`: why the last turn failed.

### POST /api/session-respond

Answers one entry of `waiting`:
`{ sessionId, requestId, decision: "allow" | "allow_always" | "deny" }` for a permission,
`{ sessionId, requestId, answers: "Blue" | ["Blue", "Large"] | { "Which color?": "Blue" } }` for a question,
`{ sessionId, requestId, approved: true | false, action?, feedback? }` for a plan.
Returns `{ success, answered }`; 404 when it was already answered.

### GET /api/session-result/:sessionId?turn=N

`{ sessionId, cwd, model, turnCount, turn: { index, userMessage, reply, toolCalls, toolErrors, durationMs }, filesChanged: [{ path, type, additions, deletions }], tokens: { input, output } }`.
`turn` defaults to the last one; `reply` is the last text the agent wrote in it.

### GET /api/session-children/:sessionId

`{ sessionId, children: [state...] }` for the sessions created with this `parentSessionId`, oldest first.

### Other endpoints

- `POST /api/interrupt-session` `{ sessionId }`: stop the turn, keep the session.
- `POST /api/stop-session` `{ sessionId }`: end it. `POST /api/kill-all` ends every one.
- `POST /api/delete-session` `{ dirName, fileName }`: end it and delete its transcript.
- `POST /api/archive-sessions` `{ sessionIds: [...], archived: true | false }`: hide from or restore to the sidebar; the transcript is untouched. Idle sessions auto-archive after 14 days unless restored, and new activity unarchives them.
- `GET /api/projects`: `[{ dirName, path, shortName, sessionCount, lastModified }]`.
- `GET /api/sessions/:dirName?page=1&limit=20`: a project's sessions, newest first.
- `GET /api/active-sessions?search=&project=&limit=&archived=include`: recent sessions across projects. `search` also matches pull requests (`#157`, `repo#157`, a PR URL); while the PR index builds, poll until `X-Cogpit-PR-Index-Pending` is `0`.
- `GET /api/session-context/:sessionId`: parsed overview of every turn; drill into `/turn/:i` and `/agent/:agentId`.
- `GET /api/sessions/:dirName/:fileName`: raw transcript JSONL (`?tail=N`, `?before=<byteOffset>&count=N` to page).
- `GET /api/find-session/:sessionId`: `{ dirName, fileName }`.
- `GET /api/running-processes`: agent processes with PID, memory and CPU.
- `GET /api/agent-executable/claude`: which Claude Code binary Cogpit spawns.

## Notes

- The Cogpit app (or `bun run dev` in the agent-window repo) must be running.
- Sessions stay alive between messages, so follow-ups have no cold start.
- Claude transcripts live in `~/.claude/projects/<dirName>/`; Codex and Copilot
  transcripts stay in their own trees but go through the same endpoints.
