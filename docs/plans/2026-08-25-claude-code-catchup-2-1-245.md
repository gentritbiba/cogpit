# Claude Code Feature Catch-up (2.1.172 → 2.1.245) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring Cogpit up to date with Claude Code 2.1.173–2.1.245 — fix parsing/rendering that current CLI versions broke, consume transcript data already on disk that Cogpit ignores, render the tools Claude now calls, and adopt the new agent-SDK options.

**Architecture:** Additive and surgical. Extend shared types, extend the shared parser, extend renderers, add SDK options. No breaking changes to existing data structures. The shared session code under `shared/session/` is consumed by the app, the server, and `packages/cogpit-memory` — changes there must keep all four typecheck targets green.

**Tech Stack:** React 19, TypeScript, Vite/Electron, Express, `@anthropic-ai/claude-agent-sdk`, vitest, bun, Tailwind 4, Lucide icons.

**Scope:** Tiers 1–4 of the 2026-08-25 audit — items verified against the codebase and against real transcripts in `~/.claude/projects/`. Tier 5 (TUI-derived UX borrows) is explicitly out of scope.

---

## Pre-flight

Before any task:

- Working dir is `/Users/gentritbiba/agent-window/.worktrees/cc-catchup` (branch `cc-catchup`, based on `master`)
- Use `bun`, not `npm`
- Run `bun run test && bun run typecheck && bun run lint` after each task
- Commit each task individually with a descriptive message
- DO NOT add Claude as co-author on commits
- DO NOT push or open PRs without explicit user consent

**Known-flaky baseline:** `src/components/__tests__/ProjectFilesPanel.test.tsx` and
`src/components/ChatInput/__tests__/ChatInputSettings.mobile.test.tsx` intermittently time out
under full-suite parallel load. Both pass in isolation on a clean `master`. If one fails, re-run
it alone before treating it as a regression:

```bash
bun run vitest run src/components/__tests__/ProjectFilesPanel.test.tsx
```

**Evidence used to build this plan** (re-derivable, useful when a task's assumptions need checking):

```bash
# Tool names Claude actually calls, ranked
find ~/.claude/projects -name '*.jsonl' -newermt '2026-06-15' -print0 \
  | xargs -0 grep -ohE '"type":"tool_use","id":"[^"]*","name":"[^"]+"' \
  | sed 's/.*"name":"//;s/"$//' | sort | uniq -c | sort -rn

# Sidecar record types written alongside messages
find ~/.claude/projects -name '*.jsonl' -newermt '2026-06-15' -print0 \
  | xargs -0 grep -ohE '^\{"type":"[a-zA-Z_-]+"' | sed 's/^{"type":"//;s/"$//' \
  | sort | uniq -c | sort -rn
```

---

## Phase 0 — Foundations

### Task 1: Bump the agent SDK

**Why:** Installed `0.3.226`, latest `0.3.245`. Later tasks depend on option names present in the
newer `sdk.d.ts`.

**Files:**
- Modify: `package.json`
- Modify: `bun.lock` (auto)

**Step 1: Bump**

```bash
bun add @anthropic-ai/claude-agent-sdk@latest
```

**Step 2: Verify the options this plan relies on exist**

```bash
grep -c "onElicitation\|supportedDialogKinds\|agentProgressSummaries\|promptSuggestions" \
  node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Expected: a non-zero count. If zero, STOP — the rest of Phase 4 is invalid.

**Step 3: Full check**

```bash
bun run test && bun run typecheck && bun run lint
```

Expected: all pass (modulo the flaky baseline above). Patch-level SDK bumps should not break types;
if a real breaking change surfaces, STOP and report.

**Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): bump claude-agent-sdk to 0.3.245"
```

---

## Phase 1 — Correctness fixes

### Task 2: Real per-model context limits

**Why:** `shared/session/contextWindow.ts` sets `DEFAULT_CONTEXT_LIMIT === EXTENDED_CONTEXT_LIMIT
=== 1_000_000`, so every model reports a 1M window. Haiku 4.5, Sonnet 4.5, Opus 4.1/4.5 are all
200K — those sessions show ~5× too much headroom and the context bar never turns red before
compaction. Verified against LiteLLM's `max_input_tokens`:

| 1M | 200K |
|---|---|
| opus-5, opus-4-8, opus-4-7, opus-4-6 | opus-4-5, opus-4-1, opus-4 |
| sonnet-5, sonnet-4-6 | sonnet-4-5 |
| fable-5, mythos-5 | haiku-4-5 |

Note the split is *not* family-based: `sonnet-4-5` is 200K but `sonnet-4-6` is 1M.

**Files:**
- Modify: `shared/session/contextWindow.ts:11-17`
- Test: `shared/session/__tests__/contextWindow.test.ts` (create if missing)

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest"
import { getContextLimit } from "../contextWindow"

describe("getContextLimit", () => {
  it("reports 200k for the models that have a 200k window", () => {
    expect(getContextLimit("claude-haiku-4-5-20251001")).toBe(200_000)
    expect(getContextLimit("claude-sonnet-4-5")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-5")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-1")).toBe(200_000)
  })

  it("reports 1m for current-generation models", () => {
    expect(getContextLimit("claude-opus-5")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-5")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-8")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-4-6")).toBe(1_000_000)
    expect(getContextLimit("claude-fable-5")).toBe(1_000_000)
  })

  it("honours an explicit [1m] suffix on a 200k model", () => {
    expect(getContextLimit("claude-sonnet-4-5[1m]")).toBe(1_000_000)
  })

  it("treats an unknown model as current-generation", () => {
    expect(getContextLimit("claude-opus-6")).toBe(1_000_000)
    expect(getContextLimit("")).toBe(1_000_000)
  })

  it("ignores a provider prefix", () => {
    expect(getContextLimit("vertex_ai/claude-haiku-4-5")).toBe(200_000)
    expect(getContextLimit("bedrock/anthropic.claude-sonnet-4-5")).toBe(200_000)
  })
})
```

**Step 2: Run to verify failure**

```bash
bun run vitest run shared/session/__tests__/contextWindow.test.ts
```

Expected: FAIL — every 200K case returns `1000000`.

**Step 3: Implement**

Replace `shared/session/contextWindow.ts:11-17` with:

```ts
const EXTENDED_CONTEXT_LIMIT = 1_000_000
const STANDARD_CONTEXT_LIMIT = 200_000

/**
 * Models whose context window is 200k. Everything else is treated as
 * current-generation (1M), so a model released after this list was written
 * reports the larger window rather than a stale small one.
 *
 * Deliberately not family-based: sonnet-4-5 is 200k while sonnet-4-6 is 1M.
 * Source: LiteLLM `max_input_tokens`, the same table used for pricing.
 */
const STANDARD_CONTEXT_MODELS = [
  "claude-haiku-4-5",
  "claude-haiku-4",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-opus-4-1",
]

export function getContextLimit(model: string): number {
  const normalized = model.trim().toLowerCase()
  // An explicit [1m] request wins over the model's default window.
  if (normalized.includes("[1m]")) return EXTENDED_CONTEXT_LIMIT
  // Provider-prefixed ids (`vertex_ai/…`, `bedrock/anthropic.…`) embed the
  // model name, so a substring match covers every spelling.
  const isStandard = STANDARD_CONTEXT_MODELS.some((id) => normalized.includes(id))
  return isStandard ? STANDARD_CONTEXT_LIMIT : EXTENDED_CONTEXT_LIMIT
}
```

Note `claude-opus-4` (the bare 2025 model) is intentionally absent — `claude-opus-4-5`/`4-1`
cover the real ids, and a bare `claude-opus-4` prefix would wrongly capture `claude-opus-4-8`.

**Step 4: Verify pass**

```bash
bun run vitest run shared/session/__tests__/contextWindow.test.ts
bun run test && bun run typecheck
```

**Step 5: Mirror into cogpit-memory if it carries a copy**

```bash
ls packages/cogpit-memory/src/lib/contextWindow.ts 2>/dev/null && \
  bun run sync-cogpit-memory && bun run check:cogpit-memory-sync
```

**Step 6: Commit**

```bash
git add shared/session/contextWindow.ts shared/session/__tests__/contextWindow.test.ts
git commit -m "fix(context): report each model's real context window instead of 1M for all"
```

---

### Task 3: Task notifications wrapped in `<system-reminder>`

**Why:** `shared/session/turnBuilder.ts:53` hides injected notices from the timeline with
`trimmed.startsWith("<task-notification>")`. CC 2.1.234 began wrapping background-task
notifications in `<system-reminder>` tags, so the prefix test misses and the notice is treated as a
user-authored queued prompt. `stripSystemTags` then blanks the body, producing an empty user bubble.

**Files:**
- Modify: `shared/session/turnBuilder.ts:50-56`
- Test: `src/lib/__tests__/turnBuilder.test.ts`

**Step 1: Write the failing test**

Add to the existing queued-prompt describe block:

```ts
it("hides a task notification wrapped in a system-reminder envelope", () => {
  const wrapped = '<system-reminder>\n<task-notification>\n<task-id>abc</task-id>\n'
    + '</task-notification>\n</system-reminder>'
  expect(isVisibleQueuedPrompt(wrapped)).toBe(false)
})

it("still shows a prompt that merely mentions a system reminder", () => {
  expect(isVisibleQueuedPrompt("why did a system-reminder show up?")).toBe(true)
})
```

`isVisibleQueuedPrompt` is currently module-private. Export it from
`shared/session/turnBuilder.ts` so it can be tested directly, and import it in the test file.

**Step 2: Run to verify failure**

```bash
bun run vitest run src/lib/__tests__/turnBuilder.test.ts
```

Expected: FAIL — the wrapped notification is reported visible.

**Step 3: Implement**

```ts
/**
 * Queue entries also carry internal task notifications; only user-authored
 * prompts belong in the timeline. CC 2.1.234+ wraps these in a
 * <system-reminder> envelope, so the marker is matched anywhere in the leading
 * tag run rather than only at the very start.
 */
export function isVisibleQueuedPrompt(content: string | null | undefined): content is string {
  if (!content?.trim()) return false
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("<")) return true
  return !trimmed.includes("<task-notification>")
    && !trimmed.startsWith("<local-command-")
    && !trimmed.startsWith("<system-reminder>")
}
```

The `startsWith("<")` guard keeps prose that merely mentions the tag visible.

**Step 4: Verify pass, then full suite**

```bash
bun run vitest run src/lib/__tests__/turnBuilder.test.ts
bun run test && bun run typecheck
```

**Step 5: Commit**

```bash
git add shared/session/turnBuilder.ts src/lib/__tests__/turnBuilder.test.ts
git commit -m "fix(timeline): hide task notifications wrapped in system-reminder envelopes"
```

---

### Task 4: Nested subagent parentage

**Why:** CC 2.1.219 raised the default subagent spawn depth from 1 to 3. `server/sdk-session.ts`
handles nesting on the live path via `parent_tool_use_id`, but the on-disk watcher
(`server/subagentWatcher.ts:58-82`) resolves a subagent file's parent only against the *main
thread's* pending `Task`/`Agent` prompts. A depth-2 agent's prompt never matches any main-thread
Task call, so its transcript is dropped or mis-claimed by a sibling.

**Files:**
- Modify: `server/subagentWatcher.ts`
- Test: `server/__tests__/subagentWatcher.test.ts`

**Step 1: Read the current resolution logic**

```bash
sed -n '40,110p' server/subagentWatcher.ts
sed -n '210,245p' server/subagentWatcher.ts
```

Understand `pendingTaskCalls`, `claims`, and `resolveParentToolId` before changing anything.

**Step 2: Write the failing test**

Model a depth-2 spawn: main thread runs `Agent` (tool id `toolA`) whose transcript itself contains
an `Agent` call (tool id `toolB`); a third agent file's opening prompt matches `toolB`, not any
main-thread call.

```ts
it("binds a nested subagent to a Task call made inside another subagent", async () => {
  // agent-1 is spawned by the main thread's toolA
  // agent-2's prompt matches a Task call that appears inside agent-1's transcript
  // Expect agent-2 to resolve to toolB, not to be dropped.
})
```

Follow the fixture style already used in `server/__tests__/subagentWatcher.test.ts`.

**Step 3: Run to verify failure**

```bash
bun run vitest run server/__tests__/subagentWatcher.test.ts
```

Expected: FAIL — the nested agent resolves to `undefined` and its lines are dropped.

**Step 4: Implement**

Register Task/Agent tool calls discovered *inside* subagent transcripts into the same
`pendingTaskCalls` map that `forwardLine` already walks, so a nested spawn is resolvable by the
identical prompt-matching path. Keep the existing proven/provisional claim semantics — they are
what stopped sibling agents from colliding, and nesting must not regress that.

**Step 5: Verify pass**

```bash
bun run vitest run server/__tests__/subagentWatcher.test.ts
bun run test && bun run typecheck
```

**Step 6: Commit**

```bash
git add server/subagentWatcher.ts server/__tests__/subagentWatcher.test.ts
git commit -m "fix(subagents): resolve parentage for agents nested more than one level deep"
```

---

### Task 5: Confirm the todo panel degrades cleanly

**Why:** CC 2.1.233 removed `TodoWrite`/`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` on Opus 4.8,
Sonnet 5, Fable 5, Mythos 5 and newer unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
`src/hooks/useTodoProgress.ts` keys entirely off those tools, so the progress panel now has nothing
to read on current models.

**This task deliberately changes no behaviour.** Forcing `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` on
Cogpit-spawned sessions would re-enable tools Anthropic removed and alter how the model plans —
that is a product decision, not a catch-up fix. The parser stays because it still serves older
sessions and any session that opts the tools back in. The only work here is proving the panel
returns `null` rather than rendering an empty shell, and recording why.

**Files:**
- Modify: `src/hooks/useTodoProgress.ts` (comment only)
- Test: `src/hooks/__tests__/useTodoProgress.test.ts`

**Step 1: Write the test**

```ts
it("returns null for a session that never called a todo tool", () => {
  const session = makeSession([{ toolCalls: [{ name: "Bash", input: { command: "ls" } }] }])
  const { result } = renderHook(() => useTodoProgress(session))
  expect(result.current).toBeNull()
})
```

**Step 2: Run**

```bash
bun run vitest run src/hooks/__tests__/useTodoProgress.test.ts
```

Expected: PASS. If it FAILS, the panel is rendering an empty shell and needs a real guard —
fix that before moving on.

**Step 3: Record the constraint**

Add above the hook:

```ts
/**
 * Reads todo state from TodoWrite and the TaskCreate/TaskUpdate pair.
 *
 * Claude Code 2.1.233 removed these tools on Opus 4.8, Sonnet 5, Fable 5,
 * Mythos 5 and newer unless CLAUDE_CODE_ENABLE_TODO_TOOLS=1, so on a current
 * model this returns null and the panel does not render. Kept for older
 * sessions and for anyone who opts the tools back in.
 */
```

**Step 4: Commit**

```bash
git add src/hooks/useTodoProgress.ts src/hooks/__tests__/useTodoProgress.test.ts
git commit -m "test(todos): pin graceful degradation now that todo tools are model-gated"
```

---

## Phase 2 — Consume transcript data already on disk

### Task 6: `thinking_tokens` in token usage

**Why:** Assistant lines carry `usage.output_tokens_details.thinking_tokens` (36,357 occurrences in
the local corpus). `shared/session/types.ts:110-118` does not declare it, and
`shared/session/token-costs.ts` still estimates thinking cost with a ~4-chars/token heuristic whose
docstring says thinking tokens are absent. They are not.

**Files:**
- Modify: `shared/session/types.ts:110-118`
- Modify: `shared/session/token-costs.ts`
- Test: `src/lib/__tests__/token-costs.test.ts`

**Step 1: Extend the type**

```ts
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  /** "fast" when the turn ran in fast mode (billed at a higher tier on Opus 4.6/4.7) */
  speed?: string
  /** CC 2.1.19x+ reports the thinking slice of output_tokens exactly. */
  output_tokens_details?: { thinking_tokens?: number }
}
```

**Step 2: Write the failing test**

```ts
it("prefers the reported thinking token count over the character estimate", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 500,
    output_tokens_details: { thinking_tokens: 320 },
  }
  expect(thinkingTokens(usage, "a".repeat(4000))).toBe(320)
})

it("falls back to the estimate when the field is absent", () => {
  const usage = { input_tokens: 100, output_tokens: 500 }
  expect(thinkingTokens(usage, "a".repeat(4000))).toBe(1000)
})
```

**Step 3: Run to verify failure, implement, verify pass**

Thinking tokens are already counted inside `output_tokens`, so this changes *reporting
granularity*, not totals. Do not add thinking tokens to any cost sum — that would double-bill.

**Step 4: Commit**

```bash
git commit -m "feat(usage): read reported thinking tokens instead of estimating from characters"
```

---

### Task 7: Per-message reasoning effort

**Why:** CC 2.1.212 records `effort` on every assistant record. `server/sessionMetadata.ts:110-112`
reads it for the session-level value only; it is not declared on `AssistantMessage` and never
surfaced per turn. CC 2.1.243 shows model + effort per subagent in `/tasks`; Cogpit's
`src/components/stats/AgentCard.tsx` carries neither.

**Files:**
- Modify: `shared/session/types.ts` (`AssistantMessage`)
- Modify: `shared/session/turnBuilder.ts` (carry `effort` onto the turn)
- Modify: `src/components/stats/AgentCard.tsx` (render the badge)
- Test: `src/lib/__tests__/turnBuilder.test.ts`, `src/components/stats/__tests__/AgentCard.test.tsx`

**Step 1: Extend `AssistantMessage`**

```ts
export interface AssistantMessage extends BaseMessage {
  type: "assistant"
  message: { /* unchanged */ }
  requestId?: string
  /** Reasoning effort this response ran at (CC 2.1.212+): low | medium | high | xhigh | max. */
  effort?: string
}
```

**Step 2: Write failing tests** — a turn built from an assistant record carrying
`"effort": "xhigh"` exposes `effort` on the turn; `AgentCard` renders the effort badge when present
and renders nothing extra when absent.

**Step 3: Implement, verify, commit**

```bash
git commit -m "feat(timeline): surface per-message reasoning effort"
```

---

### Task 8: Native `pr-link` records

**Why:** CC writes `{"type":"pr-link", prNumber, prUrl, prRepository, timestamp}` directly
(513 records across 19 local sessions). `shared/session/prLinks.ts` instead pairs a literal
`gh pr create` invocation with a GitHub URL in its output — so it misses PRs opened via `gh api` or
`curl`, PRs opened by background agents (CC 2.1.198 auto-opens draft PRs), PRs created after a push,
and GitLab merge requests entirely.

Keep the existing scanner: it recovers `title` and `isDraft` from the command line, which the
`pr-link` record does not carry, and it still covers Codex transcripts. Add the native record as an
additional, authoritative source and merge through the existing `mergePullRequests`.

**Files:**
- Modify: `shared/session/prLinks.ts`
- Test: `shared/session/__tests__/prLinks.test.ts`

**Step 1: Write the failing test**

```ts
it("records a pull request from a native pr-link record", () => {
  const line = JSON.stringify({
    type: "pr-link",
    sessionId: "s1",
    prNumber: 100,
    prUrl: "https://github.com/HonestCMS/cms/pull/100",
    prRepository: "HonestCMS/cms",
    timestamp: "2026-07-28T20:37:34.139Z",
  })
  expect(scanPullRequests(line + "\n")).toEqual([
    expect.objectContaining({ number: 100, repo: "HonestCMS/cms", url: expect.stringContaining("/pull/100") }),
  ])
})

it("does not double-count a pr-link that the gh pr create scanner already found", () => {
  // same url via both paths -> one entry
})

it("records a GitLab merge request from a pr-link record", () => {
  // prUrl ending /-/merge_requests/7 -> recorded, number 7
})
```

**Step 2: Run to verify failure**

Expected: FAIL — `scanLine` returns early because the line contains neither `gh pr create` nor
`/pull/`.

**Step 3: Implement**

- Extend the cheap pre-filter in `scanLine` to also admit `"pr-link"`.
- Handle `record.type === "pr-link"` before the payload/message branches, deriving
  `{url, number, repo}` from `prUrl`/`prNumber`/`prRepository`, with `title: null` and
  `isDraft: false`.
- `toolCallId` has no meaning for these records; use `""` and make sure the "jump back to the tool
  call" affordance tolerates an empty id rather than rendering a dead link.
- Dedup already keys on url inside `createCollector`, so a PR found both ways collapses to one.
- The `PR_URL` regex stays GitHub-only for the *command output* path; `pr-link` records carry the
  url directly and must not be run through it, which is what unlocks GitLab.

**Step 4: Verify pass, run full suite, commit**

```bash
git commit -m "feat(pr): read native pr-link records so non-gh and GitLab PRs are recorded"
```

---

### Task 9: Attribution fields in the parser

**Why:** Every assistant line carries `attributionSkill`, and where applicable `attributionPlugin`,
`attributionMcpServer`, `attributionMcpTool`. The local corpus has thousands of records
(`commit` 6,214 · `vercel-sandbox` 3,428 · `agent-browser` 3,240 · …). Cogpit references none of
them. This is the single highest-leverage unused signal in the audit: it makes "which skill burned
my tokens" answerable, and Cogpit already has both the cost aggregation layer
(`server/lib/usageCost/aggregate.ts`) and a stats surface.

This task lands the data; Task 10 renders it.

**Files:**
- Modify: `shared/session/types.ts` (`AssistantMessage`, and the `Turn` shape)
- Modify: `shared/session/turnBuilder.ts`
- Test: `src/lib/__tests__/turnBuilder.test.ts`

**Step 1: Extend the type**

```ts
/** What drove this response, when the CLI could attribute it (CC 2.1.17x+). */
export interface MessageAttribution {
  skill?: string
  plugin?: string
  mcpServer?: string
  mcpTool?: string
}
```

Add `attribution?: MessageAttribution` to `AssistantMessage` and carry it onto the turn.

**Step 2: Write the failing test**

```ts
it("carries attribution from the assistant record onto the turn", () => {
  const session = parseSession(assistantLine({ attributionSkill: "commit" }))
  expect(session.turns[0].attribution).toEqual({ skill: "commit" })
})

it("omits attribution entirely when the record carries none", () => {
  const session = parseSession(assistantLine({}))
  expect(session.turns[0].attribution).toBeUndefined()
})
```

Prefer `undefined` over `{}` so downstream code can branch on presence without checking emptiness.

**Step 3: Implement, verify, sync cogpit-memory, commit**

```bash
bun run sync-cogpit-memory && bun run check:cogpit-memory-sync
git commit -m "feat(parser): carry skill/plugin/MCP attribution onto turns"
```

---

### Task 10: Attribution breakdown in the stats panel

**Why:** Task 9's data, rendered. CC 2.1.174 shipped exactly this in the VS Code extension:
per-skill / per-agent / per-plugin / per-MCP usage over a time window.

**Files:**
- Create: `shared/session/attributionStats.ts`
- Modify: `src/components/stats/` (add a panel; follow `AgentsPanel.tsx` for layout and
  `InputOutputChart.tsx` for how token totals are already aggregated)
- Test: `shared/session/__tests__/attributionStats.test.ts`

**Step 1: Write the failing test for the pure aggregator first**

```ts
it("totals tokens and turn counts per skill", () => {
  const turns = [
    turn({ attribution: { skill: "commit" }, usage: { input_tokens: 10, output_tokens: 5 } }),
    turn({ attribution: { skill: "commit" }, usage: { input_tokens: 20, output_tokens: 5 } }),
    turn({ attribution: { skill: "qa" }, usage: { input_tokens: 1, output_tokens: 1 } }),
  ]
  expect(aggregateBySkill(turns)).toEqual([
    { name: "commit", turns: 2, inputTokens: 30, outputTokens: 10 },
    { name: "qa", turns: 1, inputTokens: 1, outputTokens: 1 },
  ])
})

it("groups unattributed turns under a single bucket", () => { /* … */ })
```

Sort output by token total descending so the panel has a stable, useful order without sorting in the
component.

**Step 2: Implement the aggregator, then the panel**

Keep all arithmetic in `shared/session/attributionStats.ts` and keep the component presentational —
that is the existing split in `src/components/stats/` and it keeps the logic testable without
rendering.

**Step 3: Verify, screenshot, commit**

Per the repo convention, verify the panel in a real browser once it renders, and include the
screenshot in the task report.

```bash
git commit -m "feat(stats): break down usage by skill, plugin, and MCP server"
```

---

### Task 11: Unhandled sidecar record types

**Why:** Four record types appear in transcripts and are silently ignored. Each is cheap to surface
and each answers a question a session viewer should be able to answer:

| Record | Payload | Why it matters |
|---|---|---|
| `worktree-state` | `worktreeName`, `worktreeBranch`, `originalBranch`, `worktreePath` | Which worktree a session is operating in |
| `agent-setting` | `agentSetting` | Which agent type a session was launched as |
| `last-prompt` | `lastPrompt`, `leafUuid` | 6,589 records; a cheap resume label |
| `atis-latch` | `atis` | Observed empty in the local corpus |

**Scope decision:** implement `worktree-state` and `agent-setting` only. `last-prompt` duplicates
information Cogpit already derives from the transcript, and `atis-latch` has an empty payload in
every local occurrence — adding fields for either would be speculative. Note them in the type file
as known-ignored so the next audit does not re-litigate them.

**Files:**
- Modify: `shared/session/types.ts`
- Modify: `server/sessionMetadata.ts:268-280` (the scanning loop)
- Test: `server/__tests__/sessionMetadata.test.ts`

**Step 1: Write the failing tests** — a transcript containing a `worktree-state` record exposes
`worktreeName`/`worktreeBranch` on the metadata; one containing `agent-setting` exposes
`agentSetting`; a transcript with neither leaves both undefined.

**Step 2: Implement, verify, commit**

```bash
git commit -m "feat(sessions): surface worktree and agent-type records from the transcript"
```

---

## Phase 3 — Render the tools Claude now calls

### Task 12: Tool summary extractors

**Why:** These tools appear in real transcripts with no `case` in
`shared/session/toolSummary.ts`, so they fall through to `defaultToolSummary`'s "first string key"
branch and render as raw-ish JSON. Local call counts since 2026-06-15:

`StructuredOutput` 219 · `ListAgents` 99 · `TaskUpdate` 98 · `SendMessage` 65 · `TaskCreate` 53 ·
`TaskOutput` 13 · `TaskList` 3

Also add `Workflow`, `ReportFindings`, `LSP`, `DesignSync`, and `Artifact` — present upstream,
not yet observed locally. `Workflow` already has a dedicated panel; it still needs a one-line
summary on the tool card.

**Files:**
- Modify: `shared/session/toolSummary.ts` (Claude switch, ends at ~line 523)
- Test: `shared/session/__tests__/toolSummary.test.ts`

**Step 1: Write the failing tests**

```ts
const cases: Array<[string, Record<string, unknown>, string]> = [
  ["SendMessage",      { to: "reviewer", summary: "asked for a second look" }, "reviewer · asked for a second look"],
  ["ListAgents",       {},                                                     ""],
  ["TaskCreate",       { subject: "Fix the flaky test" },                      "Fix the flaky test"],
  ["TaskUpdate",       { taskId: "3", status: "completed" },                   "3 → completed"],
  ["TaskList",         {},                                                     ""],
  ["TaskOutput",       { taskId: "3" },                                        "3"],
  ["TaskStop",         { taskId: "3" },                                        "3"],
  ["StructuredOutput", { area: "auth", summary: "two surfaces" },              "auth"],
  ["ReportFindings",   { findings: [{}, {}] },                                 "2 findings"],
  ["LSP",              { action: "definition", file: "src/a.ts" },             "definition · src/a.ts"],
  ["Workflow",         { name: "review-changes" },                             "review-changes"],
]

it.each(cases)("summarises %s", (name, input, expected) => {
  expect(getToolSummary({ name, input })).toBe(expected)
})
```

Adjust each expectation to the real input shape before implementing — confirm against a live call:

```bash
grep -aoh '"name":"TaskUpdate","input":.\{0,300\}' \
  ~/.claude/projects/*/*.jsonl | head -3
```

Do not guess a field name that no transcript shows.

**Step 2: Run to verify failure, implement the `case` arms, verify pass**

`ListAgents` and `TaskList` take no meaningful input; returning `""` is correct — the tool name
alone is the whole story, and an empty summary is how the card already renders bare tools.

**Step 3: Commit**

```bash
git commit -m "feat(timeline): summarise the task, agent-mail, and structured-output tools"
```

---

### Task 13: Tool tier classification

**Why:** `TOOL_TIERS` in `src/components/timeline/ToolCallCard.tsx:59-88` omits `Agent`,
`TaskStop`, `SendMessage`, `TaskCreate`, `TaskUpdate`, and `EndConversation`. All fall through to
`DEFAULT_TOOL_TIER = "readOnly"` and render muted — but spawning an agent, killing one, messaging
another session, and ending a conversation all change the world. The file's own docstring says
colour encodes what a call does; these are miscoded.

**Files:**
- Modify: `src/components/timeline/ToolCallCard.tsx:59-88`
- Test: `src/components/timeline/__tests__/ToolCallCard.test.tsx`

**Step 1: Write the failing test**

```ts
it.each(["Agent", "TaskStop", "TaskCreate", "TaskUpdate", "SendMessage", "EndConversation"])(
  "treats %s as a mutating call",
  (name) => expect(toolTier(name)).toBe("mutating"),
)

it.each(["ListAgents", "TaskList", "TaskOutput", "LSP"])(
  "treats %s as read-only",
  (name) => expect(toolTier(name)).toBe("readOnly"),
)
```

Export the tier lookup if it is currently inlined.

**Step 2: Implement, verify, commit**

```bash
git commit -m "fix(timeline): classify agent-spawning and message-sending tools as mutating"
```

---

## Phase 4 — Adopt the new SDK options

### Task 14: Handle MCP elicitation — DONE

**Why:** The SDK is explicit: *"If not provided, elicitation requests that aren't handled by hooks
will be declined automatically."* Cogpit does not pass `onElicitation`, so any MCP server that asks
for form input or URL-based auth is silently declined. For an MCP-heavy setup this is a real
functional gap, not a cosmetic one.

`AskUserQuestion` already solves the identical shape — a callback the CLI blocks on, answered out of
band by the UI. Mirror it exactly rather than inventing a second mechanism.

**Files:**
- Modify: `server/sdk-session.ts` (state, options, resolver)
- Modify: `server/routes/` (an endpoint to answer, alongside the existing question resolver)
- Test: `server/__tests__/sdk-session.test.ts`

**Step 1: Read the AskUserQuestion path end to end**

```bash
grep -n "pendingUserQuestions\|resolveUserQuestion" -r server src shared | grep -v __tests__
```

**Step 2: Write the failing test**

```ts
it("parks an elicitation request until the UI answers it", async () => {
  // onElicitation called -> request appears in state.pendingElicitations
  // resolveElicitation(id, {action: "accept", content: {name: "x"}}) -> promise resolves with it
})

it("declines a parked elicitation when the session aborts", async () => {
  // abort -> resolves {action: "decline"}, nothing left pending
})
```

**Step 3: Implement**

```ts
onElicitation: (request, options) =>
  new Promise<ElicitationResult | null>((resolve) => {
    const id = options.requestId
    state.pendingElicitations.set(id, { request, askedAt: Date.now(), resolve })
    options.signal?.addEventListener("abort", () => {
      if (state.pendingElicitations.delete(id)) resolve({ action: "decline" })
    }, { once: true })
  }),
```

Correlate on `options.requestId` — `ElicitationRequest` has no id of its own except
`elicitationId`, which is URL-mode only.

**Step 4: Surface it in the UI**

Render parked elicitations through the same pending-input channel that shows questions, so an
MCP prompt appears where the user already looks. `mode: "url"` needs an open-link affordance;
`mode: "form"` needs fields driven by `requestedSchema`. If the schema is richer than the UI can
render, answer `{action: "decline"}` explicitly with a visible reason rather than parking forever —
a silent park is what this task exists to remove.

**Landed as:** `onElicitation` parks on `state.pendingElicitations` keyed by `options.requestId`,
mirroring `pendingUserQuestions`. Answers go through `GET /api/agent-prompts` +
`POST /api/elicitation-answer` in a new `server/routes/agent-prompts.ts` (one GET for elicitations
AND dialogs so the dashboard keeps a single poll tick), surfaced by `PendingHumanInputContext` and
`MissionControl/ElicitationPrompt.tsx`. Renders flat `object` schemas of string / number / integer /
boolean / string-enum properties, plus `mode:"url"` (open-link + accept) and a bare confirm with no
schema. Anything else — arrays, nested objects, non-string enums, non-object schemas — is declined
at park time with a `streamBus.publishError` line naming the server and the offending property, so
the decline is visible instead of silent. Abort resolves `{action:"decline"}`; session teardown
resolves `{action:"cancel"}` (nobody declined; the user never got to answer).

**Step 5: Verify, commit**

```bash
git commit -m "feat(mcp): answer elicitation requests instead of letting the SDK decline them"
```

---

### Task 15: Declare renderable dialog kinds — DONE

**Why:** The CLI fails closed on `supportedDialogKinds`: a kind not declared is never emitted, and
the flow behind it degrades to its no-dialog behaviour. For `refusal_fallback_prompt` that means the
classic refusal error ends the turn where the CLI would have offered a way through. Passing
`onUserDialog` alone does nothing — the kinds list is the opt-in.

**Files:**
- Modify: `server/sdk-session.ts`
- Test: `server/__tests__/sdk-session.test.ts`

**Step 1: Confirm the constraint before writing code**

```bash
grep -n "supportedDialogKinds" -B 4 -A 22 node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Two rules the test must encode: passing a non-empty list *without* the callback throws at option
intake; and an unrecognised `dialogKind` must be answered `{behavior: "cancelled"}`, which makes the
CLI apply the dialog's default.

**Step 2: Write the failing test, implement, verify**

Declare only kinds the UI genuinely renders. Start with `refusal_fallback_prompt`; adding a kind
Cogpit cannot display is worse than omitting it, because the CLI will then route real dialogs to a
surface that drops them.

**Landed as:** `supportedDialogKinds: ["refusal_fallback_prompt"]` with `onUserDialog` parking on
`state.pendingUserDialogs`. Payload/result shapes were read out of the CLI binary rather than
guessed: payload `{originalModel, fallbackModel, apiRefusalCategory?, guidanceText?,
retractedMessageUuids?}`, result `"retry_fallback" | "edit_prompt" | "cancelled"`, default
`cancelled`. Unrecognised kinds (and malformed refusal payloads) resolve `{behavior:"cancelled"}`
without parking, per the `onUserDialog` doc comment. Rendered by
`MissionControl/UserDialogPrompt.tsx`, answered via `POST /api/user-dialog-answer`.

**Step 3: Commit**

```bash
git commit -m "feat(sessions): render refusal fallback dialogs instead of failing the turn"
```

---

### Task 16: Subagent progress summaries — DONE

**Why:** `agentProgressSummaries` forks a running subagent's conversation every ~30s to produce a
short present-tense description ("Analyzing authentication module"), delivered on `task_progress`
via `summary`. It reuses the subagent's model and prompt cache, so cost is minimal. Cogpit's agents
panel currently shows a tool name or nothing while an agent runs.

**Files:**
- Modify: `server/sdk-session.ts` (set the option)
- Modify: `server/lib/streamBus.ts` (forward `summary`)
- Modify: `src/components/stats/AgentCard.tsx` (render it)
- Test: `server/__tests__/sdk-session.test.ts`, `src/components/stats/__tests__/AgentCard.test.tsx`

**Landed as:** rendered in `src/components/timeline/LiveSubagentTranscript.tsx` (the summary replaces
its "Live" label) rather than `AgentCard.tsx` — the transcript is the surface that already renders a
*running* subagent keyed by `tool_use_id`, which is what `task_progress` carries. Plumbed through a
sibling `AgentProgressContext` in `StreamingOverlayContext.tsx`, whose audience and lifecycle it
shares. `SDKTaskStartedMessage` (`depth`, `is_backgrounded`) was NOT free — it needs its own bus
event and UI — so it is deferred.

**Step 1: Write the failing tests** — a `task_progress` event carrying `summary` reaches the client;
`AgentCard` shows the summary when present and falls back to current behaviour when absent.

**Step 2: Implement, verify, screenshot, commit**

```bash
git commit -m "feat(agents): show live progress summaries for running subagents"
```

---

### Task 17: Prompt suggestions — DONE

**Why:** `promptSuggestions` emits one `prompt_suggestion` message per turn with a predicted next
prompt, piggybacking on the parent's prompt cache — "nearly free" per the SDK docs.

**Delivery semantics that will break a naive implementation:**
- It arrives *after* the `result` message. The stream loop must keep iterating past `result` or the
  suggestion is never seen. Check whether Cogpit's loop currently breaks on `result` before
  enabling the option — if it does, that is the actual work here.
- Suppressed on the first turn, after API errors, in plan mode, by
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, and by `promptSuggestionEnabled: false` in
  settings.json. Absence is normal; the UI must not reserve space for a suggestion that never comes.

**Files:**
- Modify: `server/sdk-session.ts`
- Modify: `src/components/ChatInput/` (render as a dismissible affordance above the composer)
- Test: `server/__tests__/sdk-session.test.ts`

**Landed as:** the stream loop already survived `result` — `runQuery`'s `for await (const msg of q)`
has no break, and the persistent input stream keeps the CLI process alive across turns, so no loop
change was needed. `processSDKEvent` does call `streamBus.clear()` on `result`, but `clear()` only
drops the bus session when nothing is subscribed, so a post-`result` publish still reaches a watching
client; that is now pinned by a test in `server/__tests__/lib/streamBus.test.ts`. UI is
`src/components/ChatInput/PromptSuggestionBar.tsx`.

**Step 1: Verify the stream loop survives `result`**

```bash
grep -n '"result"' server/sdk-session.ts
```

**Step 2: Write the failing test, implement, verify, commit**

```bash
git commit -m "feat(composer): offer the predicted next prompt after each turn"
```

---

## Phase 5 — Config surface

### Task 18: Refresh the built-in skills list

**Why:** `BUILTIN_SKILLS` in `server/routes/slash-suggestions.ts:70-99` lists four entries —
`simplify`, `batch`, `debug`, `compact`. The current CLI ships many more, and `batch` may no longer
exist. Slash autocomplete is therefore both incomplete and potentially wrong.

**Files:**
- Modify: `server/routes/slash-suggestions.ts:70-99`
- Test: `server/__tests__/slash-suggestions.test.ts`

**Step 1: Determine the real list from the installed CLI — do not copy it from this plan**

The audit observed these built-ins in a live session: `code-review`, `simplify`,
`fewer-permission-prompts`, `loop`, `schedule`, `claude-api`, `run`, `init`, `security-review`,
`update-config`, `keybindings-help`, `find-skills`. Confirm against the installed binary and
current docs before hardcoding, and verify whether `batch` still exists.

**Step 2: Write a test that pins the shape, not the exact roster**

A roster test will rot on the next CLI release. Assert that each entry has a name, a description,
and a valid `type`, and that a couple of stable, high-traffic entries (`simplify`, `compact`) are
present.

**Step 3: Implement, verify, commit**

```bash
git commit -m "feat(slash): refresh the built-in skill roster for CC 2.1.245"
```

---

### Task 19: Namespace plugin skills

**Why:** `server/routes/slash-suggestions.ts:174` names a plugin skill `fm.name || skillDir`, while
plugin *commands* twenty lines below correctly namespace as `${pluginDisplayName}:${name}`. Two
plugins shipping a skill with the same name are indistinguishable in autocomplete, and the name
shown does not match what the user must type. Claude Code fixed this exact bug in 2.1.216.

**Files:**
- Modify: `server/routes/slash-suggestions.ts:168-180`
- Test: `server/__tests__/slash-suggestions.test.ts`

**Step 1: Write the failing test**

```ts
it("namespaces a plugin skill by its plugin", async () => {
  // plugin "superpowers" shipping skill "brainstorm" -> "superpowers:brainstorm"
})

it("leaves a user skill unqualified", async () => {
  // ~/.claude/skills/qa -> "qa"
})
```

**Step 2: Implement, verify, commit**

Match the commands branch exactly so the two cannot drift again.

```bash
git commit -m "fix(slash): namespace plugin skills the way plugin commands already are"
```

---

## Wrap-up

### Task 20: Full verification and audit trail

**Step 1: Full check**

```bash
bun run test && bun run typecheck && bun run lint
bun run check:architecture && bun run check:duplicates && bun run check:cogpit-memory-sync
```

**Step 2: Re-run the discovery commands from Pre-flight**

Confirm no tool in the top-20 by call count still lacks a summary extractor. If the CLI has moved
on during implementation, note the delta rather than silently expanding scope.

**Step 3: Update the deployment/report trail**

Per the repo convention, record what shipped. Do not push and do not open a PR without explicit
consent.

**Step 4: Report**

Summarise per task: landed / skipped / deferred, with the reason for anything not landed.

---

## Out of scope

Recorded so the next audit does not re-derive them:

- **Tier 5 UX borrows** — loops breakdown in the usage panel, subagent-panel density, per-tool
  elapsed tickers, middle-truncated paths, markdown table row caps. Changelog-derived; not verified
  against this codebase.
- **`modelPricing` / data-residency premium / 1-hour cache-write rates** — real cost drift, but each
  needs a pricing-source decision that LiteLLM does not currently express.
- **Keyed settings.json UI** — the config browser is a raw file editor by design. Giving ~40 new CC
  settings keys a form is a product project, not a catch-up.
- **Background-session roster, cloud sessions, `/teleport`, self-hosted runners** — new session
  *kinds*, each a feature in its own right.
- **Forcing `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`** — see Task 5.

## Verification status

Every Phase 1–3 task was confirmed against this codebase and against real transcripts. Phase 4 was
confirmed against `sdk.d.ts` in `node_modules`. Phase 5 was confirmed by reading
`server/routes/slash-suggestions.ts`; the *roster* in Task 18 still needs checking against the
installed CLI, which is why that task derives it rather than trusting this document.
