---
name: cogpit-memory
description: CLI tool for Claude Code session introspection -- retrieves conversation history, tool calls, thinking, sub-agent/team activity, full-text search, and session discovery. All output is JSON to stdout.
---

# Cogpit Memory -- Session Context CLI

CLI tool that gives any AI assistant memory of past Claude Code sessions. Retrieve conversation history, tool usage, thinking, and sub-agent activity via a layered command structure. **Also supports full-text search across all sessions** and session discovery/listing.

Always start with session discovery or the overview (Layer 1), and drill into specific turns or sub-agents only as needed. Use search when you need to **find** content rather than browse known sessions.

**Prerequisite:** Bun must be installed (uses bun:sqlite for FTS5 search).

## Step 1 -- Verify the tool works

```bash
bunx cogpit-memory --help
```

If this prints usage info, proceed to Step 2. If `bunx` is not available, install the package globally:

```bash
npm install -g cogpit-memory
```

Then use `cogpit-memory` directly instead of `bunx cogpit-memory`.

## Step 2 -- Find sessions

### List recent sessions

```bash
# List recent sessions (default: last 7 days, up to 20 results)
bunx cogpit-memory sessions

# Filter by working directory
bunx cogpit-memory sessions --cwd /path/to/project

# Customize limit and time window
bunx cogpit-memory sessions --limit 50 --max-age 30d
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--limit` | `20` | Max results |
| `--max-age` | `7d` | Time window: `7d`, `12h`, `30d` |
| `--cwd` | all | Filter by working directory |

Response: array of session summaries with `sessionId`, `cwd`, `model`, `firstMessage`, `lastMessage`, `turnCount`, `status`, `mtime`.

### Get current session for a directory

```bash
bunx cogpit-memory sessions --current --cwd /path/to/project
```

Returns the most recently active session for the given working directory. The `--cwd` flag is required when using `--current` (defaults to the current working directory if omitted).

## Step 3 -- Layer 1: Get session overview (ALWAYS call this first)

This gives you every user prompt and AI reply, plus a tool usage summary per turn. **You must call this before Layer 2 or Layer 3** -- it provides the `turnIndex` and `agentId` values you need for drill-downs.

```bash
bunx cogpit-memory context <SESSION_ID>
```

Response shape:
```json
{
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "model": "claude-opus-4-6",
  "branchedFrom": null,
  "compacted": false,
  "turns": [
    {
      "turnIndex": 0,
      "userMessage": "Fix the auth bug",
      "assistantMessage": "I found the issue...",
      "toolSummary": { "Edit": 2, "Read": 3 },
      "subAgents": [
        {
          "agentId": "a7f3bc2",
          "name": "researcher",
          "type": "Explore",
          "status": "success",
          "durationMs": 12300,
          "toolUseCount": 8,
          "isBackground": false
        }
      ],
      "hasThinking": true,
      "isError": false,
      "compactionSummary": null
    }
  ],
  "stats": {
    "totalTurns": 5,
    "totalToolCalls": 23,
    "totalTokens": { "input": 45000, "output": 12000 }
  }
}
```

Key fields:
- `userMessage` -- the human's full prompt text (`null` for synthetic turns, images shown as `[image attached]`)
- `assistantMessage` -- the AI's full text response (`null` if only tools ran)
- `toolSummary` -- tool name to count (e.g., `{"Read": 5, "Edit": 2}`)
- `subAgents` -- summary of sub-agents that ran in this turn. Fields `status`, `durationMs`, `toolUseCount` may be `null` for older sessions
- `hasThinking` -- whether thinking blocks exist (boolean only; full text is in Layer 2)
- `compacted` -- `true` if the session was compacted (early context compressed)

## Step 4 -- Layer 2: Get turn detail (one turn at a time)

Use this to drill into a specific turn. Get thinking, full tool call inputs/outputs, and sub-agent summaries in chronological order.

```bash
bunx cogpit-memory context <SESSION_ID> --turn <TURN_INDEX>
```

Response shape:
```json
{
  "sessionId": "abc-123",
  "turnIndex": 0,
  "userMessage": "Fix the auth bug",
  "contentBlocks": [
    { "kind": "thinking", "text": "Let me analyze...", "timestamp": "..." },
    { "kind": "text", "text": "I found the issue.", "timestamp": "..." },
    {
      "kind": "tool_calls",
      "toolCalls": [
        { "id": "tc1", "name": "Edit", "input": { "file_path": "/a.ts" }, "result": "done", "resultTruncated": false, "isError": false }
      ],
      "timestamp": "..."
    },
    {
      "kind": "sub_agent",
      "agents": [
        { "agentId": "a7f3bc2", "name": "researcher", "type": "Explore", "prompt": "Find auth files", "resultText": "Found 3 files...", "status": "success", "durationMs": 12300, "toolUseCount": 8, "isBackground": false }
      ],
      "timestamp": "..."
    }
  ],
  "tokenUsage": { "input": 8000, "output": 2500 },
  "model": "claude-opus-4-6",
  "durationMs": 15000
}
```

Key details:
- `contentBlocks` kinds: `thinking`, `text`, `tool_calls`, `sub_agent`, `background_agent`
- Tool call `result` is truncated at 10,000 chars -- check `resultTruncated: true`
- Tool call `result` may be `null` if the tool hasn't returned yet
- Sub-agent blocks show prompt + result text. For full sub-agent conversation, use Layer 3

**Make separate requests per turn** -- do not try to batch multiple turns in one call.

## Step 5 -- Layer 3: Get sub-agent / team member detail

Drill into a specific sub-agent's full conversation. Returns the same shape as Layer 1 (an overview of the sub-agent's own turns).

```bash
bunx cogpit-memory context <SESSION_ID> --agent <AGENT_ID>
```

Get the `AGENT_ID` from Layer 1's `subAgents[].agentId` field.

Response shape:
```json
{
  "sessionId": "abc-123",
  "agentId": "a7f3bc2",
  "name": "researcher",
  "type": "Explore",
  "parentToolCallId": "tc5",
  "isBackground": false,
  "teamContext": null,
  "overview": {
    "turns": [ "..." ],
    "stats": { "..." }
  }
}
```

The `overview` field has the exact same shape as Layer 1. You can then drill into specific sub-agent turns:

```bash
bunx cogpit-memory context <SESSION_ID> --agent <AGENT_ID> --turn <TURN_INDEX>
```

This returns the same shape as Layer 2.

### Team context

If the sub-agent is a team member, `teamContext` will be populated:
```json
{
  "teamContext": {
    "teamName": "admin-ui-redesign",
    "role": "layout-dev",
    "currentTask": { "id": "3", "subject": "Redesign layout.tsx", "status": "in_progress" }
  }
}
```

**Note:** Team members using `tmux` backend are not accessible via this command (they run as separate sessions).

## Discovery chain

The typical workflow for drilling into sub-agent activity:

1. Call Layer 1 to get the session overview
2. Look at `turns[].subAgents[]` to find agent IDs
3. Call Layer 3 with the `--agent` flag to get that sub-agent's overview
4. Call Layer 3 + `--turn` to drill into a specific sub-agent turn
5. If the sub-agent itself had sub-agents, repeat from step 2 using the sub-agent's overview

## Session Search -- Find keywords across sessions

Search for keywords across all sessions or within a specific session. Searches **everything**: user messages, assistant responses, thinking blocks, tool call inputs/results, sub-agent messages, sub-agent tool calls, and compaction summaries.

**When to use search vs Layer 1:**
- You know the session -> Use Layer 1 overview, then drill with Layer 2/3
- You need to **find** which session discussed something -> Use search first, then drill into hits

### Basic usage

```bash
# Search across all recent sessions (last 5 days)
bunx cogpit-memory search "authentication"

# Search within a specific session
bunx cogpit-memory search "authentication" --session <SESSION_ID>

# Search with custom time window and more results
bunx cogpit-memory search "authentication" --max-age 30d --limit 50

# Case-sensitive search
bunx cogpit-memory search "AuthProvider" --case-sensitive
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--session` | all sessions | Scope to single session |
| `--max-age` | `5d` | Time window: `5d`, `12h`, `30d` |
| `--limit` | `20` | Max returned hits |
| `--case-sensitive` | `false` | Case sensitivity |

### Response shape

```json
{
  "query": "authentication",
  "totalHits": 47,
  "returnedHits": 20,
  "sessionsSearched": 8,
  "results": [
    {
      "sessionId": "abc-123",
      "hits": [
        {
          "location": "turn/3/userMessage",
          "snippet": "...need to fix the authentication flow before...",
          "matchCount": 2
        },
        {
          "location": "turn/5/toolCall/tc_abc/result",
          "toolName": "Read",
          "snippet": "...export function authentication(req, res)...",
          "matchCount": 1
        },
        {
          "location": "agent/a7f3bc2/turn/1/assistantMessage",
          "agentName": "researcher",
          "snippet": "...found 3 authentication-related files in...",
          "matchCount": 1
        }
      ]
    }
  ]
}
```

### Location format

Locations map directly to Layer 2/3 drill-down commands -- use them to fetch full context:
- `turn/{i}/userMessage` -- user prompt -> drill with `--turn {i}`
- `turn/{i}/assistantMessage` -- AI response -> drill with `--turn {i}`
- `turn/{i}/thinking` -- thinking blocks -> drill with `--turn {i}`
- `turn/{i}/toolCall/{id}/input` -- tool call input -> drill with `--turn {i}`
- `turn/{i}/toolCall/{id}/result` -- tool call result -> drill with `--turn {i}`
- `turn/{i}/compactionSummary` -- compaction summary -> drill with `--turn {i}`
- `agent/{agentId}/...` -- sub-agent content -> drill with `--agent {agentId}` then `--agent {agentId} --turn {i}`

### Typical workflow

1. Search for keyword: `bunx cogpit-memory search "auth"`
2. Pick a hit from results (e.g., `sessionId: "abc-123"`, `location: "turn/3/assistantMessage"`)
3. Get full turn context: `bunx cogpit-memory context abc-123 --turn 3`
4. If hit is in a sub-agent, get agent overview first: `bunx cogpit-memory context abc-123 --agent a7f3bc2`

### Performance notes

- Cross-session search uses a raw-text pre-filter -- files that can't match are skipped before expensive parsing
- Default 5-day window keeps search fast; increase `--max-age` only if needed
- Single-session search (`--session` flag) is much faster than cross-session
- Typical cross-session search: ~150 sessions in ~1-2 seconds

## Index management

The search index is an FTS5 trigram database at `~/.claude/cogpit-memory/search-index.db`. Most commands work without the index (falling back to raw file scanning), but indexed search is significantly faster.

```bash
# Show index stats (session count, staleness, DB size)
bunx cogpit-memory index stats

# Rebuild the full index from scratch
bunx cogpit-memory index rebuild
```

## Quick reference

| Goal | Command |
|------|---------|
| List recent sessions | `bunx cogpit-memory sessions` |
| Sessions for a directory | `bunx cogpit-memory sessions --cwd <path>` |
| Current session for a directory | `bunx cogpit-memory sessions --current --cwd <path>` |
| Session overview (always first) | `bunx cogpit-memory context <sessionId>` |
| Turn detail | `bunx cogpit-memory context <sessionId> --turn <N>` |
| Sub-agent overview | `bunx cogpit-memory context <sessionId> --agent <agentId>` |
| Sub-agent turn detail | `bunx cogpit-memory context <sessionId> --agent <agentId> --turn <N>` |
| **Search across sessions** | `bunx cogpit-memory search "<query>"` |
| **Search single session** | `bunx cogpit-memory search "<query>" --session <sessionId>` |
| Index stats | `bunx cogpit-memory index stats` |
| Index rebuild | `bunx cogpit-memory index rebuild` |

**Default to Layer 1 only. Drill into Layer 2/3 only when you have a specific reason.**
