# Audit Report — Background Agent Completion Status (awaiting_agents)

**Date:** 2026-08-19
**Commit:** `a233642`
**Scope:** Feature commit adding derived session status `awaiting_agents` to distinguish sessions whose turn ended from sessions awaiting background agent/workflow completion.

**Files Changed:**
- `shared/session/sessionStatus.ts` — new `SessionStatus` type value `"awaiting_agents"`, new optional fields `pendingAgents` and `pendingAgentDescriptions` on `SessionStatusInfo`, new `collectClaudeBackgroundWork()` function for detecting pending agents
- `shared/session/codex.ts`, `shared/session/codex-tool-normalization.ts` — Codex provider-specific background-work detection (spawn_agent/wait_agent lifecycle)
- `packages/cogpit-memory/src/lib/` — generated mirrors of above via `scripts/sync-cogpit-memory.ts`
- `server/sessionMetadata.ts` — status derivation incorporates background work from both Claude and Codex
- `server/routes/projects/activeSessionsRoute.ts` — new `hasFreshAgentTranscripts()` predicate; `/api/active-sessions` now includes `agentPendingAgents` field and sets `isActive` true when awaiting_agents with fresh transcripts
- `server/routes/files-watch.ts` — SSE endpoint now sends new synthetic `{type:"subagent_activity"}` event (in addition to existing `compacting_in_progress`)
- `src/lib/sessionActivity.ts`, `src/lib/__tests__/sessionStatus.test.ts` — utility functions and tests updated
- `src/components/LiveSessions/{attentionGroups.ts,types.ts,SessionRow.tsx}`, `src/components/timeline/{AgentStatusIndicator.tsx,TurnSection.tsx}` — UI components for displaying pending-agent status ("Waiting on N agents..." text/pills)
- `src/components/LiveSessions/__tests__/attentionGroups.test.ts`, `src/components/timeline/__tests__/AgentStatusIndicator.test.tsx` — test coverage
- `src/hooks/useLiveSession.ts` — session state tracking for awaiting_agents
- `src/components/LiveSessions/AttentionStrip.tsx` — one-line change: `getStatusLabel()` call gains optional 4th param (pendingAgents count)

---

## Executive Summary

Adds a new, non-terminal session status `awaiting_agents` to represent sessions whose turn has ended (stop_reason "end_turn") while background agents or workflows launched via the Agent/Workflow tools are still running. External callers polling `/api/session-status` need to know:

- `"completed"`, `"idle"`, `"deferred"` are **terminal** — turn is truly done
- `"awaiting_agents"` is **non-terminal** — turn ended, but session will resume by itself when agents notify

Includes:
- Claude detection: `toolUseResult.status === "async_launched"` + `<task-notification>` matching
- Codex detection: `spawn_agent/wait_agent/sub_agent_activity/inter-agent` lifecycle + `FINAL_ANSWER`
- Server: `/api/session-status` gains `pendingAgents`/`pendingAgentDescriptions` fields; `/api/active-sessions` gains `agentPendingAgents` field and sets `isActive` true when fresh background work is detected
- SSE: `/api/watch` sends new synthetic `{type:"subagent_activity"}` event
- UI: persistent "Waiting for your input" ready indicator; "Waiting on N agents..." status line/pills; optional 4th param to `getStatusLabel()`

### Documentation Impact

**Status:** UPDATED — one file, three edits.

`.claude/skills/cogpit-sessions/SKILL.md` listed session status values without "awaiting_agents" and did not distinguish terminal from non-terminal statuses. External agents polling for turn completion must know that `awaiting_agents` is not terminal.

No other maintained documentation makes claims contradicted by this commit.

---

## Detailed Analysis

### Change 1: SessionStatus type and detection

`shared/session/sessionStatus.ts` adds `"awaiting_agents"` to the `SessionStatus` union and two new optional fields:

```typescript
export type SessionStatus = 
  | "idle"
  | "thinking"
  | "tool_use"
  | "processing"
  | "completed"
  | "compacting"
  | "deferred"
  | "awaiting_agents"  // ← NEW

export interface SessionStatusInfo {
  status: SessionStatus
  live?: boolean
  running?: boolean
  toolName?: string
  pendingQueue?: number
  terminalReason?: string
  pendingAgents?: number  // ← NEW
  pendingAgentDescriptions?: string[]  // ← NEW
}
```

The `collectClaudeBackgroundWork()` function detects when a turn ended while Agent/Workflow tool results are still pending. Detection works by:
1. Finding all `toolUseResult.status === "async_launched"` (indicates an async launch)
2. Scanning subsequent user messages for `<task-notification>` envelopes that resolve these launches by task-id or tool-use-id
3. Matching resolved IDs against the originating tool calls
4. Counting launches with no resolution as pending

Background Bash tasks (with `backgroundTaskId`) are explicitly excluded: long-lived commands like dev servers never exit, so treating them as pending would pin status forever.

**Contract impact:** `SessionStatusInfo` adds optional fields. Existing consumers ignoring them remain compatible. New field `pendingAgents` and `pendingAgentDescriptions` only present when `status === "awaiting_agents"`.

### Change 2: Provider-specific background work

`shared/session/codex.ts` and `codex-tool-normalization.ts` detect Codex background work via the `spawn_agent`, `wait_agent`, `sub_agent_activity`, and `inter-agent` lifecycle tokens, plus `FINAL_ANSWER` markers. Mirrored into `packages/cogpit-memory/src/lib/` by `scripts/sync-cogpit-memory.ts`.

**Contract impact:** None to external APIs. Internal session status derivation logic expanded to two providers.

### Change 3: API response shapes

**`/api/session-status/:sessionId` response:**
Added optional fields `pendingAgents` (number) and `pendingAgentDescriptions` (string[]). Present only when status is `awaiting_agents`.

```typescript
// Before
{ sessionId, live, running, status, toolName?, pendingQueue?, terminalReason? }

// After
{ sessionId, live, running, status, toolName?, pendingQueue?, terminalReason?, pendingAgents?, pendingAgentDescriptions? }
```

**`/api/active-sessions` response per-session fields:**
Added `agentPendingAgents` (number, optional). New `hasFreshAgentTranscripts()` predicate checks whether subagent JSONL files have been written in the last 60 seconds. `isActive` now set to `true` when status is `awaiting_agents` and fresh agent transcripts are detected.

```typescript
// Added
agentPendingAgents?: number
isActive: ... || hasRunningAgents
```

**Contract impact:** Both additions are optional fields. Existing consumers that ignore them remain compatible. New field `agentPendingAgents` only present when `agentStatus === "awaiting_agents"`. The `isActive` boolean now reflects background agent work in addition to native Codex turns.

### Change 4: SSE event enrichment

`server/routes/files-watch.ts` sends a new synthetic `{type:"subagent_activity"}` event on every fifth tick while background agents (non-compaction) are actively writing to `<sessionId>/subagents/agent-*.jsonl` files. Mirrors the existing `compacting_in_progress` cadence (10s re-announcement).

**Contract impact:** None to existing event schemas. New event type added. Consumers must be idempotent (normal case). Consumers that did not expect `subagent_activity` will safely ignore it.

### Change 5: Renderer UI

`AgentStatusIndicator.tsx` displays a persistent "Waiting for your input" ready indicator after a witnessed turn end. `SessionRow.tsx` shows "Waiting on N agents..." status pills when `agentStatus === "awaiting_agents"`. `TurnSection.tsx` includes pending-agent descriptions in timeline display. `getStatusLabel()` utility (called from `AttentionStrip.tsx`) accepts optional 4th param for pending-agent count.

**Contract impact:** None to APIs or persisted formats. UI surface only.

### Change 6: Test coverage

New and updated tests cover:
- `src/lib/__tests__/sessionStatus.test.ts` — status derivation with async-launched agents, task notifications, resolved/pending tracking
- `src/components/LiveSessions/__tests__/attentionGroups.test.ts` — attention priority sorting with awaiting_agents status
- `src/components/timeline/__tests__/AgentStatusIndicator.test.tsx` — status indicator rendering and waiting states

---

## Documentation Audit Results

### Files Reviewed

| Document | Path | Status | Rationale |
|----------|------|--------|-----------|
| External session API skill | `.claude/skills/cogpit-sessions/SKILL.md` | **UPDATED** | Listed session status values without "awaiting_agents" and did not distinguish terminal vs. non-terminal; external agents must know awaiting_agents is not terminal |
| Architecture guide | `docs/architecture/README.md` | OK | Ownership map is unchanged; API response details not documented there |
| Agent guidance | `AGENTS.md`, `CLAUDE.md` | OK | Point to cogpit-sessions skill; no contract details documented |
| Feature plans | `docs/plans/*` | OK | No explicit session status semantics documented; only UI component plans and test tasks mentioned |
| README | `README.md` | OK | No session status details documented |

### Updates Made

**`.claude/skills/cogpit-sessions/SKILL.md`**

1. **Line 62 (status field):** Expanded status enum to include `awaiting_agents` and clarified that it is **non-terminal** — unlike `completed`, `idle`, `deferred` which are terminal. Added note: "the turn ended but background agents/workflows are still running; the session will resume by itself when they notify."

2. **Line 190 (/api/session-status response shape):** Added `pendingAgents?` and `pendingAgentDescriptions?` to response shape and documented that they are only present when `status === "awaiting_agents"`.

3. **Line 198 (/api/active-sessions fields):** Added `agentPendingAgents` to the per-session field list with clarification that it is present when status is awaiting_agents.

### Not Changed

**`docs/architecture/README.md`.** The compatibility table does not document specific HTTP response shapes — it names ownership. API contracts live in the `cogpit-sessions` skill. No change needed.

**`docs/plans/*`.** No plan explicitly documents `SessionStatus` enum values or terminal/non-terminal semantics. UI and test plans reference status indirectly but make no claims contradicted by this commit.

**`README.md`.** Makes no claim about session status semantics.

---

## Breaking Changes and Deprecations

**None for external callers, but critical awareness required:**

The new `awaiting_agents` status is **not terminal**. External agents polling `/api/session-status/:sessionId` to detect turn completion must be aware:

| Status | Terminal? | Action |
|--------|-----------|--------|
| `completed`, `idle`, `deferred` | YES | Turn is done; safe to send next message |
| `awaiting_agents` | **NO** | Turn ended, but session will resume by itself; **do not send messages yet** |
| any `terminalReason` | YES | Session ended abnormally |
| `running: true` | (in-flight) | Still processing |

This was documented in the updated SKILL.md with emphasis on non-terminal semantics.

---

## Verification

- **Tests:** New coverage for status derivation, attention groups, and status indicators
- **Risk:** LOW for external callers. Non-breaking additions to optional fields. `running` flag remains the primary completion signal; the `status` field gain new semantics but does not change behavior of existing terminal statuses. The new `awaiting_agents` status is only returned in cases where a turn genuinely ended while background work is pending — a novel case that did not exist before this commit.
- **Backward compatibility:** Clients that ignore new optional fields remain fully compatible. Clients that treat `awaiting_agents` as terminal (like the old code would have) may send messages prematurely, but this is *not a breaking change in the API* — it's a clarification that the enum expanded. The skill now explicitly documents that `awaiting_agents` is non-terminal.

---

## Change Propagation Map

```
Code Change                                  Documentation Impact
──────────────────────────────────────────────────────────────────────
shared/session/sessionStatus.ts
├─ SessionStatus += "awaiting_agents"        → SKILL.md line 62 UPDATED
├─ SessionStatusInfo + pendingAgents?        → SKILL.md line 190 UPDATED
└─ collectClaudeBackgroundWork()             → (internal detection logic)

shared/session/codex.ts
└─ Codex background-work detection           → (internal detection logic)

server/routes/projects/activeSessionsRoute.ts
├─ /api/active-sessions + agentPendingAgents → SKILL.md line 198 UPDATED
└─ isActive set true on fresh agents         → (internal optimization)

server/routes/files-watch.ts
└─ /api/watch SSE + {type:"subagent_activity"} → (event schema unchanged;
                                              consumers already idempotent)

src/components/LiveSessions/*
├─ SessionRow shows "Waiting on N agents..."  → (UI surface only)
└─ AttentionStrip getStatusLabel() 4th param → (UI internal)

src/components/timeline/*
└─ AgentStatusIndicator persistent indicator → (UI surface only)
```

---

## Conclusion

A contained feature commit with three specific documentation additions needed. The `cogpit-sessions` skill was the only maintained documentation incompletely covering the new status — its status enum list lacked `awaiting_agents`, and it did not distinguish terminal from non-terminal statuses. Three targeted edits added the missing status value and clarified that `awaiting_agents` is a non-terminal state requiring special handling by external agents.

All other documentation (architecture guide, README, agent guidance, and feature plans) either does not document session status details or makes no claims contradicted by this commit.

**Recommendation:** PASS after SKILL.md updates applied.

---

**Auditor:** Documentation Audit Agent
**Method:** `git diff HEAD` analysis of all changed files; source verification of status detection logic; skill API comparison against modified routes; full markdown sweep for status/terminal/completion references
**Confidence:** High
