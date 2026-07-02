---
name: cogpit-sessions
description: Create and manage Claude Code sessions via the Cogpit (agent-window) HTTP API running on localhost:19384. Use when an agent needs to spawn a new Claude Code session in a project directory, send messages to existing sessions, stop sessions, list projects, or query active sessions. Triggers on requests like "start a session", "run claude in project X", "send a message to session Y", "list cogpit projects", or any programmatic interaction with the agent-window server.
---

# Cogpit Sessions API

Base URL: `http://localhost:19384`

All endpoints accept/return JSON. Local requests (127.0.0.1/::1) bypass authentication.

## CRITICAL: Response Timing

These endpoints are **slow** because they spawn and wait for `claude` CLI processes:

| Endpoint | Typical response time | What it waits for |
|----------|----------------------|-------------------|
| `create-and-send` | **5–15 seconds** | JSONL file to appear on disk |
| `send-message` | **10 seconds – 5+ minutes** | Full turn completion |
| `stop-session` | instant | — |
| `GET` endpoints | instant | — |

**You MUST use long timeouts.** Always use `--max-time 30` for `create-and-send` and `--max-time 600` for `send-message`. Without these, curl will appear to return empty output.

**For `send-message`, always write output to a file and run in background** since the turn can take minutes:

```bash
# WRONG — will appear to hang or return empty:
curl -s -X POST http://localhost:19384/api/send-message ...

# CORRECT — write to file with long timeout:
curl -s --max-time 600 -X POST http://localhost:19384/api/send-message \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"...","message":"..."}' \
  > /tmp/cogpit-result.txt 2>&1 &
# Then poll /tmp/cogpit-result.txt or read the session JSONL directly
```

## Quick Start — Create a Session

```bash
# IMPORTANT: --max-time 30 is required, response takes ~5-15 seconds
curl -s --max-time 30 -X POST http://localhost:19384/api/create-and-send \
  -H "Content-Type: application/json" \
  -d '{
    "dirName": "-Users-gentritbiba-my-project",
    "message": "Hello, what files are in this project?",
    "permissions": {"allow": ["Bash","Read","Write","Edit","Glob","Grep"], "deny": []}
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

The `dirName` is the project's absolute path with `/` replaced by `-` and a leading `-`.

Example: `/Users/gentritbiba/my-project` → `-Users-gentritbiba-my-project`

To discover existing projects and their dirNames:

```bash
curl -s http://localhost:19384/api/projects
```

Returns an array of `{ dirName, path, shortName, sessionCount, lastModified }`.

## API Reference

### POST /api/create-and-send

Create a new session and send the first message. Spawns a persistent `claude` process. **Response takes 5–15 seconds — use `--max-time 30`.**

**Body:**
```json
{
  "dirName": "string (required)",
  "message": "string (required unless images provided)",
  "images": [{ "data": "base64", "mediaType": "image/png" }],
  "permissions": { "allow": ["Bash", "Read", "Write", "Edit"], "deny": [] },
  "model": "string (optional — e.g. 'claude-sonnet-4-20250514')",
  "effort": "string (optional — 'low' | 'medium' | 'high')",
  "worktreeName": "string (optional — creates a git worktree)"
}
```

**Response (200):** `{ success, dirName, fileName, sessionId, initialContent }`
**Error (400/500):** `{ error: "message" }`

The `sessionId` is used for all subsequent interactions with this session.

### POST /api/send-message

Send a follow-up message to an existing session. Reuses the persistent process if alive, otherwise spawns a new one with `--resume`. **Response waits for the full turn — can take minutes. Use `--max-time 600` and run in background.**

**Body:**
```json
{
  "sessionId": "string (required)",
  "message": "string (required unless images provided)",
  "images": [{ "data": "base64", "mediaType": "image/png" }],
  "cwd": "string (optional — working directory)",
  "permissions": { "allow": ["Bash", "Read", "Write", "Edit"], "deny": [] },
  "model": "string (optional)",
  "effort": "string (optional)"
}
```

**Response (200):** `{ success: true }`

### POST /api/stop-session

Stop a running session. Instant response.

**Body:** `{ "sessionId": "string" }`
**Response:** `{ success: true }`

### POST /api/kill-all

Kill all active claude processes managed by cogpit.

**Body:** (empty or `{}`)
**Response:** `{ success: true, killed: <count> }`

### GET /api/projects

List all projects with sessions.

**Response:** Array of `{ dirName, path, shortName, sessionCount, lastModified }`

### GET /api/sessions/:dirName

List all session files for a project.

**Response:** Array of session file metadata.

### GET /api/sessions/:dirName/:fileName

Read the raw JSONL content of a specific session file. Use this to read what Claude has written so far — the session output.

### GET /api/active-sessions

List the most recent sessions across all projects. Response items may include team membership metadata (Claude Code 2.1.19x+).

**Response fields:**
- `dirName`, `fileName`, `projectShortName`, `cwd`, `isActive` — session identity
- `teamName` (optional) — if this session is a team member
- `agentName` (optional) — member's name within the team
- `teamLeadSessionId` (optional) — UUID of the lead session; use to group teammates under their lead

### GET /api/running-processes

List all system-wide `claude` processes with PID, memory, CPU, and sessionId.

### POST /api/delete-session

Kill and permanently delete a session file.

**Body:** `{ "dirName": "string", "fileName": "string" }`

## Permissions

The `permissions` object controls what tools the spawned Claude session can use without prompting:

```json
{
  "allow": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"],
  "deny": []
}
```

Omit `permissions` to use the default (interactive approval — the session will hang waiting for user input).

**Always pass permissions** when calling from an agent, otherwise the spawned session will block on tool approvals with no one to approve them.

## Typical Agent Workflow

```bash
# 1. Discover projects
PROJECTS=$(curl -s http://localhost:19384/api/projects)
DIR_NAME=$(echo "$PROJECTS" | jq -r '.[0].dirName')

# 2. Start a session (MUST use --max-time 30)
RESULT=$(curl -s --max-time 30 -X POST http://localhost:19384/api/create-and-send \
  -H "Content-Type: application/json" \
  -d "{\"dirName\": \"$DIR_NAME\", \"message\": \"List the main source files\", \"permissions\": {\"allow\": [\"Bash\",\"Read\",\"Write\",\"Edit\",\"Glob\",\"Grep\"], \"deny\": []}}")
SESSION_ID=$(echo "$RESULT" | jq -r '.sessionId')
FILE_NAME=$(echo "$RESULT" | jq -r '.fileName')

# 3. Send follow-up (run in background — can take minutes)
curl -s --max-time 600 -X POST http://localhost:19384/api/send-message \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\", \"message\": \"Now fix the failing tests\"}" \
  > /tmp/send-result.txt 2>&1 &
CURL_PID=$!

# 4. Poll session output while waiting
sleep 10
curl -s "http://localhost:19384/api/sessions/$DIR_NAME/$FILE_NAME"

# 5. Wait for send-message to finish
wait $CURL_PID

# 6. Read final session output
curl -s "http://localhost:19384/api/sessions/$DIR_NAME/$FILE_NAME"

# 7. Stop when done
curl -s -X POST http://localhost:19384/api/stop-session \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}"
```

## Fire-and-Forget Pattern

If you just need to start a session and don't need to wait for completion:

```bash
# Start the session
RESULT=$(curl -s --max-time 30 -X POST http://localhost:19384/api/create-and-send \
  -H "Content-Type: application/json" \
  -d '{"dirName":"...","message":"Do the task","permissions":{"allow":["Bash","Read","Write","Edit","Glob","Grep"],"deny":[]}}')

# The session is now running in the background on the server.
# The claude process persists — you don't need to keep a connection open.
# Check on it later by reading the JSONL file:
DIR=$(echo "$RESULT" | jq -r '.dirName')
FILE=$(echo "$RESULT" | jq -r '.fileName')
curl -s "http://localhost:19384/api/sessions/$DIR/$FILE"
```

## Path Conversion Helper

To convert a filesystem path to a `dirName`:

```bash
# /Users/gentritbiba/projects/my-app → -Users-gentritbiba-projects-my-app
DIR_NAME=$(echo "/Users/gentritbiba/projects/my-app" | sed 's|/|-|g')
```

## Notes

- The server must be running (Cogpit app or `bun run dev` in the agent-window project)
- Sessions persist as JSONL files in `~/.claude/projects/<dirName>/`
- `create-and-send` returns as soon as the JSONL file appears on disk (does not wait for the full response) — but this still takes 5–15 seconds
- `send-message` waits for the full turn to complete before responding — this can take minutes
- The persistent process stays alive between messages — no cold-start on follow-ups
- **Always pass `permissions`** from agents — without them the session blocks on tool approvals
