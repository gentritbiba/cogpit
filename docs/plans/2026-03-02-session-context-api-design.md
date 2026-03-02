# Session Context API — Design Document

## Overview

A layered API that lets Claude agents inspect session conversation history, tool usage, thinking, and sub-agent/team activity. The API reuses the existing frontend session parser (`src/lib/parser.ts`) to avoid duplicating parsing logic.

## Three Layers

| Layer | Endpoint | Purpose |
|-------|----------|---------|
| L1 | `GET /api/session-context/:sessionId` | Session overview — user prompts, AI replies, tool name/count summaries |
| L2 | `GET /api/session-context/:sessionId/turn/:turnIndex` | Turn detail — thinking, full tool calls with results, sub-agent summaries |
| L3 | `GET /api/session-context/:sessionId/agent/:agentId` | Sub-agent/team member overview (returns L1 shape) |
| L3+L2 | `GET /api/session-context/:sessionId/agent/:agentId/turn/:turnIndex` | Sub-agent turn detail |

All four endpoints are served by a single `use("/api/session-context/", handler)` registration, dispatched by splitting `url.pathname` and checking `parts.length`.

### Rules

- Agents MUST call L1 before L2 or L3 (L1 provides the `turnIndex` and `agentId` values needed for L2/L3)
- L2 returns one turn at a time — agents make multiple requests for multiple turns
- L3 returns L1 shape — same drill-down pattern applies recursively
- Sub-agents, background agents, and team members all use the same L3 endpoint

### Route conventions

- Method guard: `if (req.method !== "GET") return next()` as first line
- All path params decoded with `decodeURIComponent()`: sessionId, agentId, turnIndex
- `turnIndex` validated as integer: return `400 { error: "Invalid turn index" }` for non-numeric, `404 { error: "Turn not found" }` for out-of-range
- Error responses: `{ error: "..." }` with appropriate status codes (400, 404, 500)
- All responses set `Content-Type: application/json`
- Try/catch wrapping with `500 { error: String(err) }` fallback

## Layer 1 — Session Overview

**`GET /api/session-context/:sessionId`**

```json
{
  "sessionId": "abc-123",
  "cwd": "/Users/user/project",
  "model": "claude-opus-4-6",
  "branchedFrom": null,
  "compacted": false,
  "turns": [
    {
      "turnIndex": 0,
      "userMessage": "Fix the auth bug in login.ts",
      "assistantMessage": "I found the issue — the token validation...",
      "toolSummary": { "Edit": 2, "Read": 3, "Bash": 1 },
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

### Field details

- `userMessage`: Extracted text from user content blocks. `turn.userMessage` is `UserContent` which can be `string | ContentBlock[]` — the mapper extracts text blocks and replaces `ImageBlock` with `[image attached]`. `null` for synthetic turns (no preceding user message).
- `assistantMessage`: `turn.assistantText` is `string[]` — the mapper joins with `"\n\n"`. `null` if the array is empty (assistant only ran tools).
- `toolSummary`: `Record<string, number>` — tool name to invocation count from `turn.toolCalls`. This includes Task/Agent spawner calls (they are the main agent's tool calls), but NOT the internal tool calls that sub-agents made.
- `subAgents`: Summary of each sub-agent/background-agent. Fields `status`, `durationMs`, `toolUseCount`, `prompt` are **optional** (only present for v2.1.63+ sessions using the `toolUseResult` format; `null` for older sessions). `name` and `type` may also be `null`.
- `hasThinking`: `true` if `turn.thinking.length > 0`.
- `isError`: `true` if any `turn.toolCalls` has `isError === true`.
- `compactionSummary`: From `turn.compactionSummary`. `null` if no compaction.
- `compacted` (top level): Derived — `true` if any turn has a non-null `compactionSummary`.
- `stats.totalTokens`: Reshaped from `SessionStats.totalInputTokens` / `totalOutputTokens` into `{ input, output }`.

## Layer 2 — Turn Detail

**`GET /api/session-context/:sessionId/turn/:turnIndex`**

```json
{
  "sessionId": "abc-123",
  "turnIndex": 0,
  "userMessage": "Fix the auth bug in login.ts",
  "contentBlocks": [
    {
      "kind": "thinking",
      "text": "Let me analyze the auth flow...",
      "timestamp": "2026-03-02T10:00:01Z"
    },
    {
      "kind": "text",
      "text": "I found the issue in the token validation.",
      "timestamp": "2026-03-02T10:00:02Z"
    },
    {
      "kind": "tool_calls",
      "toolCalls": [
        {
          "id": "tc1",
          "name": "Read",
          "input": { "file_path": "/src/auth/login.ts" },
          "result": "export function validateToken...",
          "resultTruncated": false,
          "isError": false
        }
      ],
      "timestamp": "2026-03-02T10:00:03Z"
    },
    {
      "kind": "sub_agent",
      "agents": [
        {
          "agentId": "a7f3bc2",
          "name": "researcher",
          "type": "Explore",
          "status": "success",
          "prompt": "Find all auth middleware files",
          "resultText": "Found 3 auth middleware files: ...",
          "durationMs": 12300,
          "toolUseCount": 8,
          "isBackground": false
        }
      ],
      "timestamp": "2026-03-02T10:00:05Z"
    }
  ],
  "tokenUsage": { "input": 8000, "output": 2500 },
  "model": "claude-opus-4-6",
  "durationMs": 15000
}
```

### Field details

- `contentBlocks`: Chronologically ordered from `turn.contentBlocks`. Possible `kind` values: `thinking`, `text`, `tool_calls`, `sub_agent`, `background_agent`.
- **thinking blocks**: `turn.contentBlocks` of `kind: "thinking"` contain `blocks: ThinkingBlock[]` where the text lives at `block.thinking` (not `block.text`). The mapper concatenates all `block.thinking` strings into a single `text` field. Redacted thinking blocks (empty `thinking` with non-empty `signature`) are excluded.
- **text blocks**: Concatenated from the `text: string[]` array on the content block.
- **tool_calls blocks**: Each `ToolCall` has `{ id, name, input, result, isError }`. `result` is `string | null` — `null` if the tool hasn't returned yet. Truncated at 10,000 characters with `resultTruncated: true`.
- **sub_agent / background_agent blocks**: Summary per agent with prompt and result text. For full conversation, call L3.
- `tokenUsage`: Reshaped from `Turn.tokenUsage` (`input_tokens` / `output_tokens` → `input` / `output`). `null` if no usage data.
- `durationMs`: From `turn.durationMs`. `null` if not available.

## Layer 3 — Sub-Agent / Team Member Detail

**`GET /api/session-context/:sessionId/agent/:agentId`**

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
    "turns": [ ... ],
    "stats": { ... }
  }
}
```

The `overview` field has the exact same shape as L1 (turns array + stats).

### Team context

If the sub-agent is a team member (matched via `matchSubagentToMember`), `teamContext` is populated:

```json
{
  "teamContext": {
    "teamName": "admin-ui-redesign",
    "role": "layout-dev",
    "currentTask": {
      "id": "3",
      "subject": "Redesign layout.tsx",
      "status": "in_progress"
    }
  }
}
```

### Sub-agent turn detail

**`GET /api/session-context/:sessionId/agent/:agentId/turn/:turnIndex`**

Returns the exact same shape as L2 but for a turn within the sub-agent's session.

### Known limitation: tmux-backend team members

Team members with `backendType: "tmux"` run as separate Claude processes in tmux panes — they do NOT have sub-agent JSONL files under the lead session's `subagents/` directory. L3 will return `404 { error: "Agent not found. tmux-backend team members have separate sessions not accessible via this endpoint." }`. Full support for tmux members requires a different lookup path and is deferred to v2.

## Architecture

### Shared parser

The server route imports `parseSession` from `src/lib/parser.ts` — the same function the frontend uses. This avoids duplicating parsing logic and ensures consistency.

```
JSONL on disk → parseSession() → ParsedSession → thin mappers → JSON response
```

**Build requirement:** `tsconfig.node.json` must be updated to include `src/lib` in its `include` array and add the `@/*` paths alias. The parser files (`parser.ts`, `turnBuilder.ts`, `types.ts`, `sessionStats.ts`, `interactiveState.ts`, `token-costs.ts`, `pricingTiers.ts`, `costAnalytics.ts`) are all pure TypeScript with zero browser dependencies — safe for server-side use.

### Mapper functions

Three thin mapper functions shape `ParsedSession` / `Turn` data into API responses:

- `mapSessionToOverview(session: ParsedSession)` → L1 response
- `mapTurnToDetail(session: ParsedSession, turnIndex: number)` → L2 response
- `extractUserMessageText(userMessage: UserContent | null)` → string extraction helper

These handle all the type transformations documented above (joining string arrays, reshaping token usage, extracting text from ContentBlock arrays, etc.).

### No caching

Parse the full JSONL on each request. The parser is fast enough (frontend does this on every session load). Optimize later if needed.

### Sub-agent JSONL resolution

Sub-agent files live at: `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`

To find the file:
1. Use `findJsonlPath(sessionId)` to locate the parent session JSONL
2. Derive the subagents directory: `parentJsonlPath.replace(/\.jsonl$/, '') + '/subagents/'`
3. **Scan the directory** for `agent-*.jsonl` files, extract agentId from each filename (`f.replace("agent-", "").replace(".jsonl", "")`), and match against the requested agentId. Do NOT construct the filename directly — the agentId in `SubAgentMessage` may not exactly match the filename slug.

### Team member enrichment

For L3, after finding the sub-agent file:
1. Read team configs from `~/.claude/teams/*/config.json` (via `dirs.TEAMS_DIR`)
2. Check if parent session's `sessionId` matches any team's `leadSessionId`
3. If yes, call `matchSubagentToMember(leadSessionId, subagentFileName, members)` — note this function takes the **filename** (e.g., `agent-a7f3bc2.jsonl`), not a path
4. If matched, look up their active task from `~/.claude/tasks/<teamName>/`

### Truncation

Tool call results are truncated at 10,000 characters in L2. A `resultTruncated: boolean` field indicates if truncation occurred.

## Files to create/modify

| File | Action |
|------|--------|
| `server/routes/session-context.ts` | New — route handler + mappers |
| `server/__tests__/routes/session-context.test.ts` | New — tests |
| `server/api-plugin.ts` | Edit — register routes |
| `electron/server.ts` | Edit — register routes |
| `tsconfig.node.json` | Edit — add `src/lib` to include, add `@/*` paths alias |
| `~/.claude/skills/session-context/SKILL.md` | New — global skill |

## Edge cases

| Edge case | Handling |
|-----------|----------|
| Compacted sessions | `compacted: true` + `compactionSummary` on affected turns |
| Turns with no assistant text | `assistantMessage: null` |
| Synthetic turns (no user message) | `userMessage: null` |
| Meta user messages (`isMeta`) | Excluded by parser |
| Old sub-agent format (agent_progress) | Parser normalizes to `SubAgentMessage` |
| New sub-agent format (toolUseResult) | Same normalization |
| Background agents | `isBackground: true` in sub-agent summaries |
| Team members | L3 enriches with `teamContext` |
| tmux-backend team members | L3 returns 404 with explanation (deferred to v2) |
| Nested sub-agents | L3 returns L1 shape — recursive drill-down |
| Branched sessions | `branchedFrom` field in L1 |
| Session not found | `404 { error: "Session not found" }` |
| Agent not found | `404 { error: "Agent not found" }` |
| Invalid turn index (non-numeric) | `400 { error: "Invalid turn index" }` |
| Turn index out of range | `404 { error: "Turn not found" }` |
| Redacted thinking | Excluded (empty `thinking` with non-empty `signature`) |
| Images in user messages | Replaced with `[image attached]` |
| Tool result too large | Truncated at 10K chars, `resultTruncated: true` |
| Tool call with no result yet | `result: null` |
| SubAgentMessage optional fields | Default to `null` in response |
| Malformed JSONL lines | Parser skips with try/catch |
| Server error | `500 { error: String(err) }` |
