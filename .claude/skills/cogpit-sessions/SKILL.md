---
name: cogpit-sessions
description: Create and manage Claude Code sessions via the Cogpit (agent-window) HTTP API running on localhost:19384. Use when an agent needs to spawn a new Claude Code session in a project directory, send messages to existing sessions, stop sessions, list projects, or query active sessions. Triggers on requests like "start a session", "run claude in project X", "send a message to session Y", "list cogpit projects", or any programmatic interaction with the agent-window server.
---

# Cogpit sessions API

## Base URL and port

The packaged app binds an ephemeral port unless network access pins 19384. Resolve the port in this order:

```bash
PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"
BASE="http://localhost:$PORT"
```

`~/.cogpit/port` is written on server start and removed on exit. All endpoints accept and return JSON. Local requests (127.0.0.1/::1) bypass authentication.

## CRITICAL: permissions

The server defaults to permission mode `default`, which gates tool calls behind interactive approval. A headless caller has no one to click Approve, so the session stalls on its first gated tool call. **Always pass:**

```json
"permissions": { "mode": "bypassPermissions" }
```

Full shape:

```json
{
  "mode": "bypassPermissions" | "default" | "plan" | "acceptEdits" | "dontAsk" | "auto",
  "allowedTools": ["Bash", "Read", "Write"],
  "disallowedTools": []
}
```

- `bypassPermissions` runs every tool without prompting (`claude --dangerously-skip-permissions`). Use this from agents.
- Any other mode gates tool calls. Only use when a human is watching the Cogpit UI.
- `allowedTools` / `disallowedTools` are CLI tool names, applied as allow/deny lists in the gated modes.
- The old `{ "allow": [...], "deny": [...] }` shape is **silently ignored**. Sending it leaves the session in `default` mode and it hangs. Do not use it.

## Response timing

| Endpoint | Response time | Notes |
|----------|--------------|-------|
| `create-and-send` | 5–15 s | waits for the JSONL file to appear on disk |
| `send-message` | instant OR full turn | instant when the session's SDK query is live (the normal case after `create-and-send`); waits for the whole turn only when it must resume a cold session |
| everything else | instant | |

Use `--max-time 30` for `create-and-send`. For `send-message` use `--max-time 600` and run it in the background, since the resume path can take minutes.

**A 200 from `send-message` does NOT mean the turn finished.** Poll `/api/session-status/:sessionId` to detect completion (next section).

## Detecting turn completion

```bash
curl -s "$BASE/api/session-status/$SESSION_ID"
# → { "sessionId": "...", "live": true, "running": false, "status": "completed", "pendingQueue": 0 }
```

- `running`: a turn is in flight right now. This is the primary completion signal for sessions Cogpit manages: it flips true as soon as the server accepts a message (before `send-message` even responds) and false exactly at the turn boundary, so it does not suffer the JSONL flush lag that `status` does. Poll until it is `false`.
- `status`: one of `idle` | `thinking` | `tool_use` | `processing` | `completed` | `compacting` | `deferred` | `awaiting_agents`, derived from the session JSONL tail. Terminal statuses: `completed`, `idle`, `deferred`, or any `terminalReason`. **Non-terminal:** `awaiting_agents` means the turn ended but background agents/workflows are still running; the session will resume by itself when they notify. For sessions the server does not manage (started in a terminal, or before a server restart), treat terminal statuses as the end of turn. It can briefly report the previous turn's `completed` right after a send, so prefer `running` when it is available.
- `live`: the server holds an open SDK query or process that can take follow-ups without a resume. Stays `true` between turns for SDK and legacy sessions; native Codex sessions only report `live` during a turn.
- `pendingQueue`: user messages queued but not yet processed. Wait for it to hit 0 as well if you sent several messages back to back.
- `terminalReason`: set when the session ended abnormally.
- `pendingAgents`: (only when `status === "awaiting_agents"`) number of background agents/workflows still running.
- `pendingAgentDescriptions`: (only when `status === "awaiting_agents"`) short descriptions of pending agents, oldest first.

Poll loop:

```bash
sleep 2   # let the server accept the message you just sent
while [ "$(curl -s "$BASE/api/session-status/$SESSION_ID" | jq -r .running)" = "true" ]; do
  sleep 5
done
```

## Quick start

```bash
curl -s --max-time 30 -X POST "$BASE/api/create-and-send" \
  -H "Content-Type: application/json" \
  -d '{
    "dirName": "-Users-gentritbiba-my-project",
    "message": "What files are in this project?",
    "permissions": {"mode": "bypassPermissions"}
  }'
```

Response:

```json
{
  "success": true,
  "dirName": "-Users-gentritbiba-my-project",
  "fileName": "<uuid>.jsonl",
  "sessionId": "<uuid>",
  "initialContent": "..."
}
```

## Finding the dirName

The `dirName` is the project's absolute path with every non-alphanumeric character replaced by `-`:

```bash
# /Users/x/my.app → -Users-x-my-app
DIR_NAME=$(echo "/Users/x/my.app" | sed 's|[^a-zA-Z0-9]|-|g')
```

Discover existing projects instead of guessing:

```bash
curl -s "$BASE/api/projects"
# → [{ dirName, path, shortName, sessionCount, lastModified }]
```

Codex projects appear with `codex__<base64url-of-cwd>` dirNames and a `(Codex)` suffix on `shortName`. The same endpoints drive Codex sessions.

## API reference

### POST /api/create-and-send

Create a session and send the first message. Spawns a persistent SDK session that stays alive for follow-ups.

Body:

```json
{
  "dirName": "string (required)",
  "message": "string (required unless images provided)",
  "images": [{ "data": "base64", "mediaType": "image/png" }],
  "permissions": { "mode": "bypassPermissions" },
  "model": "string (e.g. 'sonnet', 'opus', or a full model id; GET /api/models lists options)",
  "effort": "'low' | 'medium' | 'high' | 'xhigh' | 'max'",
  "fastMode": "boolean (fast/priority service tier)",
  "ultracode": "boolean (Claude ultracode; needs xhigh-capable model)",
  "worktreeName": "string (runs the session in a git worktree with this name)",
  "mcpConfig": "string (JSON-encoded mcpServers config, passed to the SDK)",
  "name": "string (session name)",
  "cwd": "string (optional absolute path; must encode to dirName)"
}
```

Response 200: `{ success, dirName, fileName, sessionId, initialContent }`. Error 400/500: `{ error }`.

### POST /api/send-message

Send a follow-up. Enqueues on the live SDK query if the session is still running, otherwise resumes it.

Body: `{ "sessionId": "...", "message": "...", "images": [...], "cwd": "...", "permissions": {...}, "model": "...", "effort": "...", "fastMode": ..., "ultracode": ..., "mcpConfig": "..." }`

`sessionId` plus `message` or `images` are required. `permissions` and `cwd` only apply on the resume path. Response: `{ success: true }`. See the timing section: poll `session-status` for completion.

### POST /api/interrupt-session

`{ "sessionId": "..." }`. Interrupts the current turn but keeps the session alive for the next message. Response: `{ success: boolean }`.

### POST /api/stop-session

`{ "sessionId": "..." }`. Kills the session's process/query. Response: `{ success: true }`, or `{ success: false, error }` when nothing was running.

### POST /api/kill-all

Kill every agent process Cogpit manages. Response: `{ success, killed }`.

### POST /api/delete-session

`{ "dirName": "...", "fileName": "..." }`. Kills the session and permanently deletes its JSONL file.

### GET /api/projects

All projects with sessions: `[{ dirName, path, shortName, sessionCount, lastModified }]`.

### GET /api/sessions/:dirName?page=1&limit=20

Paginated session list for a project, newest first: `{ sessions, total, page, pageSize }`. Each session shares the shape of `/api/active-sessions` (see below): `sessionId`, `fileName`, `size`, `lastModified`, `lastActivityAt`, `model`, `gitBranch`, `turnCount`, `agentStatus`, `agentToolName`, `agentTerminalReason`, `agentPendingAgents`, and optional `pullRequests` (when the index has scanned the transcript). Plus session metadata (`cwd`, `firstUserMessage`, `lastUserMessage`, `timestamp`, `aiTitle`, `customTitle`, `version`, ...).

### GET /api/sessions/:dirName/:fileName

Raw session JSONL as `text/plain`. For large sessions page it:

- `?tail=N` returns the last N turns' worth of lines as JSON: `{ headerLines, tailLines, byteOffset, totalSize, hasMore }`
- `?before=<byteOffset>&count=N` pages backward from a previous response's `byteOffset`: `{ headerLines, lines, byteOffset, hasMore }`

### GET /api/session-context/:sessionId

Parsed session overview: turn summaries, tool call counts, token totals. Much easier to consume than raw JSONL. Drill down with `/turn/:turnIndex` (full turn detail) and `/agent/:agentId` (subagent transcripts, plus `/agent/:agentId/turn/:i`). Prefer this for reading what a session did.

### GET /api/session-status/:sessionId

`{ sessionId, live, running, status, toolName?, pendingQueue?, terminalReason?, pendingAgents?, pendingAgentDescriptions? }`. See "Detecting turn completion". 404 if the session doesn't exist. `pendingAgents` and `pendingAgentDescriptions` are only present when `status === "awaiting_agents"`.

### GET /api/find-session/:sessionId

Resolve a bare sessionId to `{ dirName, fileName }`.

### GET /api/active-sessions

Recent sessions across all projects, newest first. `?search=<q>` filters by title/message/branch/cwd content. Fields per session: `dirName`, `projectShortName`, `fileName`, `sessionId`, `cwd`, `gitBranch`, `model`, `turnCount`, `lastActivityAt`, `agentStatus` (same values as session-status), `agentToolName`, `agentPendingAgents` (present when status is awaiting_agents), `pullRequests`, and for team members `teamName`, `agentName`, `teamLeadSessionId`.

### GET /api/running-processes

System-wide agent processes with PID, memory, CPU, and sessionId.

## Typical agent workflow

```bash
PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"
BASE="http://localhost:$PORT"

# 1. Discover the project
DIR_NAME=$(curl -s "$BASE/api/projects" | jq -r '.[0].dirName')

# 2. Start a session (--max-time 30 required; response takes 5-15s)
RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/create-and-send" \
  -H "Content-Type: application/json" \
  -d "{\"dirName\": \"$DIR_NAME\", \"message\": \"List the main source files\", \"permissions\": {\"mode\": \"bypassPermissions\"}}")
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')

# 3. Send a follow-up in the background
curl -s --max-time 600 -X POST "$BASE/api/send-message" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\", \"message\": \"Now fix the failing tests\"}" \
  > /tmp/send-result.txt 2>&1 &

# 4. Poll until the turn completes
sleep 2
while [ "$(curl -s "$BASE/api/session-status/$SESSION_ID" | jq -r .running)" = "true" ]; do
  sleep 5
done

# 5. Read what happened (parsed, no JSONL wrangling)
curl -s "$BASE/api/session-context/$SESSION_ID"

# 6. Stop when done
curl -s -X POST "$BASE/api/stop-session" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}"
```

## Fire-and-forget

Start a task and check on it later. The server-side process persists; no connection needs to stay open.

```bash
RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/create-and-send" \
  -H "Content-Type: application/json" \
  -d '{"dirName":"...","message":"Do the task","permissions":{"mode":"bypassPermissions"}}')
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')

# Later:
curl -s "$BASE/api/session-status/$SESSION_ID"
curl -s "$BASE/api/session-context/$SESSION_ID"
```

## Notes

- The server must be running (Cogpit app, or `bun run dev` in the agent-window project).
- Claude sessions persist as JSONL in `~/.claude/projects/<dirName>/`; Codex rollouts live in Codex's own sessions tree but are served through the same endpoints.
- The SDK session stays alive between messages, so follow-ups have no cold start and skip permission re-negotiation.
- Always pass `{"mode": "bypassPermissions"}`; the legacy `{allow, deny}` permissions shape is ignored and leaves the session hanging in `default` mode.
