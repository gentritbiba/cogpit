# Session Branching Design

## Overview

Add the ability to duplicate/branch a session, creating a new independent session with all prior conversation state. Supports branching from the end (full copy) or from a specific turn (truncated copy).

## Core Mechanism

The branch operation is a server-side JSONL file copy:

1. Read the source session's JSONL file
2. Generate a new UUID for the branched session
3. Copy lines from the source file up to the target turn (or all lines for full copy)
4. Rewrite the first line's metadata with the new `sessionId` and add `branchedFrom: { sessionId, turnIndex }` metadata
5. Write the new file as `<newSessionId>.jsonl` in the same project directory
6. Return the new session info to the client

No Claude process is spawned at branch time (cold branch). When the user sends their first message in the branch, the existing `send-message` flow spawns a process with `--session-id`, and Claude CLI resumes from the JSONL state.

## API

### `POST /api/branch-session`

**Request:**
```json
{
  "dirName": "my-project",
  "fileName": "original-session-id.jsonl",
  "turnIndex": null
}
```

- `turnIndex: null` = full copy (branch from end)
- `turnIndex: <number>` = branch from specific turn, truncating everything after

**Response:**
```json
{
  "dirName": "my-project",
  "fileName": "new-session-id.jsonl",
  "sessionId": "new-session-id",
  "branchedFrom": "original-session-id"
}
```

### Route handler logic

1. Read the source JSONL file
2. Parse lines and identify turn boundaries (user messages mark new turns)
3. If `turnIndex` is set, keep only lines up through that turn's completion
4. Replace `sessionId` in the metadata line, add `branchedFrom` info
5. Write the new file to the same project directory
6. Return the new session details

Lives in `server/routes/claude-new.ts` alongside existing session creation routes.

## UI

### Trigger Points

**Session sidebar (session list):**
- Branch icon button on each session row
- Performs full-copy branch and navigates to the new session

**Active chat — turn-level:**
- "Branch from here" option on individual turns (hover action or context menu)
- Branches with `turnIndex` set to that turn, truncating everything after
- Navigates to the new branched session

### Branched Session Indicator

- Small branch icon/badge in session list for branched sessions
- Tooltip or subtitle: "Branched from <parent session slug>"
- Driven by `branchedFrom` metadata in the JSONL first line

## Data Flow

1. User clicks branch (sidebar or turn-level)
2. Client POSTs to `/api/branch-session` with `dirName`, `fileName`, optional `turnIndex`
3. Server copies JSONL, returns new session info
4. Client dispatches `LOAD_SESSION` to switch to the branched session
5. Session renders like any existing session, ready for new input

Sending a message in the branch uses the standard `send-message` flow. No persistent process exists yet, so one is spawned with `--session-id <newId>`.

## Parser Changes

Extract `branchedFrom` from the JSONL metadata line into `ParsedSession` for UI display. Minimal addition to existing metadata extraction in `server/helpers.ts` and `src/lib/parser.ts`.

## No Changes Needed

- `SessionSetupPanel` — branched session inherits model/permissions from original
- Reducer actions — reuses existing `LOAD_SESSION`
- Live streaming — works as-is once a message is sent
