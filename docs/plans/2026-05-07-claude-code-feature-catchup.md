# Claude Code Feature Catch-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring agent-window up to date with Claude Code features shipped between Feb–May 2026 (CLI 2.1.78 → 2.1.132), so the dashboard renders new event types, tools, and metadata correctly.

**Architecture:** Additive changes — extend types, extend parser, extend renderers. No breaking changes to existing data structures. Touch points: `src/lib/types.ts`, `src/lib/turnBuilder.ts`, `src/components/timeline/*`, `server/routes/*`, `package.json`.

**Tech Stack:** React 19, TypeScript, Vite/Electron, Express, `@anthropic-ai/claude-agent-sdk`, vitest, bun, Tailwind 4, Lucide icons.

**Testing:** Each task includes vitest unit tests under `__tests__/`. Run via `bun run test`. UI changes verified via `bun run lint && bun run typecheck`.

---

## Pre-flight

Before any task:
- Working dir is `/Users/gentritbiba/agent-window`
- Use `bun`, not `npm` (per project CLAUDE.md)
- Run `bun run test && bun run typecheck && bun run lint` after each task
- Commit each task individually with a descriptive message
- DO NOT add Claude as co-author on commits (per global CLAUDE.md)
- DO NOT push or open PRs without explicit user consent

---

## Task 1: Bump @anthropic-ai/claude-agent-sdk to latest

**Why:** 21 patches behind (0.2.111 → 0.2.132). Includes MCP reconfigure fixes, deferred-tool restoration after compaction, async hook fixes.

**Files:**
- Modify: `package.json:32`
- Modify: `bun.lock` (auto)

**Step 1: Bump version**
```bash
cd /Users/gentritbiba/agent-window
bun add @anthropic-ai/claude-agent-sdk@latest
```

**Step 2: Run tests + typecheck**
```bash
bun run test
bun run typecheck
```
Expected: All pass. If failures, read each one and fix surface-level type changes only. If a real breaking change surfaces (unlikely for patch versions), STOP and report.

**Step 3: Commit**
```bash
git add package.json bun.lock
git commit -m "chore(deps): bump claude-agent-sdk to latest"
```

---

## Task 2: Tool summary extractors for new tools

**Why:** `Monitor`, `CronCreate/Delete/List`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `EnterWorktree`/`ExitWorktree` all currently render as raw JSON. Quick win: add summary extraction so the timeline shows useful info.

**Files:**
- Modify: `src/components/timeline/ToolCallCard.tsx:17-76` (TOOL_BADGE_STYLES + getToolSummary)
- Modify: `src/components/timeline/ToolCallCard.tsx:274` (COMPACT_MOBILE_TOOLS)
- Test: `src/components/timeline/__tests__/ToolCallCard.test.tsx` (create if missing)

**Step 1: Write failing tests**

In `src/components/timeline/__tests__/ToolCallCard.test.tsx`, add tests asserting `getToolSummary` returns expected strings for:

- `Monitor` with `{ bash_id: "abc", filter: "ERROR" }` → `"abc · filter=ERROR"`
- `CronCreate` with `{ schedule: "0 */6 * * *", prompt: "/babysit-prs" }` → `"0 */6 * * * → /babysit-prs"`
- `CronList` with `{}` → `""`
- `CronDelete` with `{ id: "cron_123" }` → `"cron_123"`
- `ScheduleWakeup` with `{ delaySeconds: 1800, reason: "polling deploy" }` → `"in 30m · polling deploy"`
- `RemoteTrigger` with `{ action: "run", id: "trig_42" }` → `"run trig_42"`
- `PushNotification` with `{ title: "Build done", body: "..." }` → `"Build done"`
- `EnterWorktree` with `{ name: "fix-auth", branch: "feat/auth", path: "/x/y" }` → `"fix-auth (/x/y)"`
- `ExitWorktree` with `{ name: "fix-auth" }` → `"fix-auth"`
- `Skill` with `{ skill: "commit", args: "" }` → `"commit"`
- `ToolSearch` with `{ query: "select:Read", max_results: 5 }` → `"select:Read"`

Need to import `getToolSummary`. If not exported, export it from `ToolCallCard.tsx`.

**Step 2: Run tests, see them fail**
```bash
bun run test src/components/timeline/__tests__/ToolCallCard.test.tsx
```
Expected: FAIL — extractors return generic fallback text.

**Step 3: Implement extractors**

In `getToolSummary` (after the `AskUserQuestion` case), add:

```typescript
case "Monitor": {
  const bashId = String(input.bash_id ?? "")
  const filter = input.filter ? ` · filter=${input.filter}` : ""
  return `${bashId}${filter}`
}
case "CronCreate": {
  const sched = String(input.schedule ?? input.cron ?? "")
  const prompt = String(input.prompt ?? "")
  const trimmed = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt
  return sched && trimmed ? `${sched} → ${trimmed}` : sched || trimmed
}
case "CronList":
  return ""
case "CronDelete":
  return String(input.id ?? input.cron_id ?? "")
case "ScheduleWakeup": {
  const sec = Number(input.delaySeconds ?? 0)
  const m = Math.round(sec / 60)
  const human = sec >= 3600 ? `${Math.round(sec/3600)}h` : sec >= 60 ? `${m}m` : `${sec}s`
  const reason = input.reason ? ` · ${input.reason}` : ""
  return `in ${human}${reason}`
}
case "RemoteTrigger": {
  const action = String(input.action ?? "")
  const id = String(input.id ?? input.trigger_id ?? "")
  return [action, id].filter(Boolean).join(" ")
}
case "PushNotification":
  return String(input.title ?? input.body ?? "")
case "EnterWorktree": {
  const name = String(input.name ?? input.branch ?? "")
  const path = input.path ? ` (${input.path})` : ""
  return `${name}${path}`
}
case "ExitWorktree":
  return String(input.name ?? input.branch ?? "")
case "Skill":
  return String(input.skill ?? input.name ?? "")
case "ToolSearch":
  return String(input.query ?? "")
```

Also extend `TOOL_BADGE_STYLES` with appropriately-toned entries:

```typescript
Monitor: "bg-cyan-500/5 text-cyan-400/40 border-cyan-500/10",
CronCreate: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
CronDelete: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
CronList: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
ScheduleWakeup: "bg-violet-500/5 text-violet-400/40 border-violet-500/10",
RemoteTrigger: "bg-blue-500/5 text-blue-400/40 border-blue-500/10",
PushNotification: "bg-pink-500/10 text-pink-400/60 border-pink-500/20",
EnterWorktree: "bg-emerald-500/5 text-emerald-400/40 border-emerald-500/10",
ExitWorktree: "bg-emerald-500/5 text-emerald-400/40 border-emerald-500/10",
Skill: "bg-indigo-500/10 text-indigo-400/60 border-indigo-500/20",
ToolSearch: "bg-slate-500/5 text-slate-400/40 border-slate-500/10",
```

Add to `COMPACT_MOBILE_TOOLS`: `"Monitor", "CronList", "ToolSearch"` (low signal on mobile).

**Step 4: Run tests, see them pass**
```bash
bun run test src/components/timeline/__tests__/ToolCallCard.test.tsx
bun run typecheck
```

**Step 5: Commit**
```bash
git add src/components/timeline/ToolCallCard.tsx src/components/timeline/__tests__/ToolCallCard.test.tsx
git commit -m "feat(timeline): add summary extractors for Monitor/Cron/Skill/Worktree tools"
```

---

## Task 3: Hook event types in JSONL parser

**Why:** Claude Code now emits hook events into the session JSONL — `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `StopFailure`, `PostCompact`, `PreCompact`, `PermissionDenied`, `TaskCreated`, `WorktreeCreate`, `CwdChanged`, `FileChanged`, `Elicitation`, `ElicitationResult`. Currently `progress` messages with `data.type === "hook_progress"` are recognized but not parsed.

**Files:**
- Modify: `src/lib/types.ts:121-124` (extend HookProgressData)
- Test: `src/lib/__tests__/turnBuilder.test.ts` (or create)

**Step 1: Identify real-world hook event payload shapes**

Check fixtures in `src/lib/__tests__/fixtures/` and `server/__tests__/`. If no real hook event JSONL exists, examine `~/.claude/projects/` for recent sessions:
```bash
fgrep -l hook_event_name ~/.claude/projects/*/*.jsonl | head -3
```
Read 1-2 lines from each to confirm shape.

**Step 2: Extend HookProgressData type**

In `src/lib/types.ts`, replace `HookProgressData` interface:

```typescript
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "StopFailure"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "PermissionDenied"
  | "TaskCreated"
  | "WorktreeCreate"
  | "CwdChanged"
  | "FileChanged"
  | "Elicitation"
  | "ElicitationResult"
  | "Notification"

export interface HookProgressData {
  type: "hook_progress"
  hook_event_name?: HookEventName | string
  /** Source of the hook configuration: "settings" | "plugin" | "skill" */
  source?: string
  /** Tool call this hook is associated with (for Pre/PostToolUse) */
  tool_use_id?: string
  /** Tool name (Pre/PostToolUse) */
  tool_name?: string
  /** Hook command line that ran */
  command?: string
  /** stdout/stderr from the hook command */
  output?: string
  stderr?: string
  /** Exit code */
  exit_code?: number
  /** Decision returned by hook (allow/deny/block/ask/defer) */
  decision?: string
  /** Duration in milliseconds (PostToolUse, 2.1.119+) */
  duration_ms?: number
  /** Hook-specific output (e.g., updatedToolOutput, sessionTitle) */
  hookSpecificOutput?: Record<string, unknown>
  /** Permits arbitrary additional fields without coupling */
  [key: string]: unknown
}
```

**Step 3: Add a derived ParsedHookEvent type**

Below the `ContentBlock` type definitions, add:

```typescript
export interface ParsedHookEvent {
  /** Event name like "PreToolUse" */
  eventName: string
  /** Source: settings/plugin/skill */
  source?: string
  /** Tool the hook is gated on (for Pre/PostToolUse) */
  toolName?: string
  toolUseId?: string
  /** Command that ran */
  command?: string
  output?: string
  stderr?: string
  exitCode?: number
  decision?: string
  /** Duration in ms */
  durationMs?: number
  /** PostToolUse hooks (2.1.121) can replace tool output via updatedToolOutput */
  updatedToolOutput?: string
  /** UserPromptSubmit hooks (2.1.94) can set sessionTitle */
  sessionTitle?: string
  /** WorktreeCreate hooks (2.1.84) return worktreePath */
  worktreePath?: string
  timestamp: string
}
```

Add to `TurnContentBlock` union:

```typescript
  | { kind: "hook_event"; events: ParsedHookEvent[]; timestamp?: string }
```

**Step 4: Write parser tests**

Create or extend `src/lib/__tests__/turnBuilder.test.ts` with tests that feed a synthetic JSONL containing a `progress` message with `data.type === "hook_progress"` and `hook_event_name === "PostToolUse"`, and assert the resulting turn contains a `hook_event` content block with the parsed fields.

**Step 5: Implement parsing in turnBuilder**

In `src/lib/turnBuilder.ts`, find the section that handles `ProgressMessage` (the deprecated `agent_progress` handler around line 437-460). Add a sibling branch for `hook_progress` that:
1. Extracts `hook_event_name`, `tool_name`, `tool_use_id`, `output`, `stderr`, `exit_code`, `decision`, `duration_ms`, `hookSpecificOutput`
2. Pulls `updatedToolOutput`, `sessionTitle`, `worktreePath` from `hookSpecificOutput`
3. Pushes a `ParsedHookEvent` into the current turn's `contentBlocks` as a `hook_event` block (group consecutive hook events into one block to avoid spam)
4. If event has `tool_use_id` matching a known tool call, attach as metadata for the renderer to display inline

**Step 6: Run tests**
```bash
bun run test src/lib/__tests__/turnBuilder.test.ts
bun run typecheck
```

**Step 7: Commit**
```bash
git add src/lib/types.ts src/lib/turnBuilder.ts src/lib/__tests__/turnBuilder.test.ts
git commit -m "feat(parser): parse hook lifecycle events from progress messages"
```

---

## Task 4: Hook event timeline renderer

**Why:** Once parsed, hook events need a UI surface. They should be small, dismissable chips that don't dominate the timeline.

**Files:**
- Create: `src/components/timeline/HookEventChip.tsx`
- Modify: `src/components/timeline/TurnSection.tsx` (handle the new `hook_event` content block kind)
- Modify: `src/components/timeline/ToolCallCard.tsx` (show inline `duration_ms` and `updatedToolOutput` indicator)

**Step 1: Read TurnSection to see how it dispatches content block kinds**

Read `src/components/timeline/TurnSection.tsx`. Find the switch/match on `block.kind` and identify the dispatch pattern.

**Step 2: Create HookEventChip component**

```typescript
// src/components/timeline/HookEventChip.tsx
import { memo, useState } from "react"
import { ChevronRight, ChevronDown, Webhook, AlertCircle } from "lucide-react"
import type { ParsedHookEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Props {
  events: ParsedHookEvent[]
}

const TERMINAL_EVENTS = new Set(["StopFailure", "PermissionDenied", "PostToolUseFailure"])

export const HookEventChip = memo(function HookEventChip({ events }: Props) {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  const hasError = events.some(e => TERMINAL_EVENTS.has(e.eventName) || (e.exitCode !== undefined && e.exitCode !== 0))
  const Chev = open ? ChevronDown : ChevronRight
  return (
    <div className={cn("py-1 px-2 my-1 rounded text-[11px]", hasError ? "bg-red-950/15" : "bg-elevation-0/40")}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 w-full text-left text-muted-foreground hover:text-foreground">
        <Chev className="w-3 h-3 shrink-0" />
        {hasError ? <AlertCircle className="w-3 h-3 text-red-400" /> : <Webhook className="w-3 h-3" />}
        <span className="font-mono">{events.length} hook event{events.length === 1 ? "" : "s"}</span>
        <span className="truncate text-muted-foreground/60">
          {events.map(e => e.eventName).join(", ")}
        </span>
      </button>
      {open && (
        <ul className="mt-1 ml-5 space-y-0.5 font-mono">
          {events.map((e, i) => (
            <li key={i} className="text-muted-foreground/80">
              <span className="text-foreground">{e.eventName}</span>
              {e.toolName && <span> · {e.toolName}</span>}
              {e.source && <span className="text-muted-foreground/50"> ({e.source})</span>}
              {e.decision && <span className="text-amber-400"> → {e.decision}</span>}
              {e.durationMs !== undefined && <span className="text-muted-foreground/50"> {e.durationMs}ms</span>}
              {e.exitCode !== undefined && e.exitCode !== 0 && <span className="text-red-400"> exit {e.exitCode}</span>}
              {e.stderr && <pre className="mt-0.5 ml-2 text-red-300/80 whitespace-pre-wrap">{e.stderr.slice(0, 500)}</pre>}
              {e.updatedToolOutput && <span className="text-blue-400"> · output replaced by hook</span>}
              {e.sessionTitle && <span className="text-purple-400"> · title: {e.sessionTitle}</span>}
              {e.worktreePath && <span className="text-emerald-400"> · path: {e.worktreePath}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
```

**Step 3: Wire into TurnSection**

Add a case in TurnSection's content-block switch for `kind === "hook_event"` that renders `<HookEventChip events={block.events} />`.

**Step 4: Add inline duration_ms and updatedToolOutput indicator on ToolCallCard**

In `ToolCallCard.tsx`, extend the `ToolCall` type indirectly via an optional `meta` prop OR via cross-referencing parser output. Simpler: pass an optional `hookMeta?: { durationMs?: number; outputReplaced?: boolean }` prop to the component. Render a small badge next to `StatusIcon` if present:
- `durationMs >= 0` → `<span className="text-[10px] text-muted-foreground/50 tabular-nums">{durationMs}ms</span>`
- `outputReplaced` → `<span className="text-[10px] text-blue-400">hook</span>`

For now, just plumb the prop with `undefined` everywhere — the parser cross-link comes in Task 5 (or as a follow-up).

**Step 5: Tests**

In `src/components/timeline/__tests__/HookEventChip.test.tsx`, render the chip with 2 events and assert:
- The collapsed text shows "2 hook events"
- After click, both events are listed
- Error styling applies when one event has `exitCode: 2`

**Step 6: Run tests + lint + typecheck**
```bash
bun run test src/components/timeline
bun run typecheck
bun run lint
```

**Step 7: Commit**
```bash
git add src/components/timeline/HookEventChip.tsx src/components/timeline/TurnSection.tsx src/components/timeline/ToolCallCard.tsx src/components/timeline/__tests__/HookEventChip.test.tsx
git commit -m "feat(timeline): render hook lifecycle events as collapsible chips"
```

---

## Task 5: Plan mode first-class rendering

**Why:** `EnterPlanMode` currently shows as muted secondary tool. Plans now have real workflow weight — file paths, persistence across resume, ultraplan refinement.

**Files:**
- Create: `src/components/timeline/PlanModeBlock.tsx`
- Modify: `src/components/timeline/TurnSection.tsx` (intercept Enter/Exit pairs)
- Modify: `src/lib/turnBuilder.ts` (group EnterPlanMode/ExitPlanMode pairs into a `plan_mode` content block)

**Step 1: Group EnterPlanMode → ExitPlanMode in parser**

In `src/lib/types.ts`, add to `TurnContentBlock`:
```typescript
  | { kind: "plan_mode"; plan: string; planFilePath?: string; status: "pending" | "approved" | "rejected"; toolCalls: ToolCall[]; timestamp?: string }
```

In `turnBuilder.ts`, when processing `tool_calls` blocks, detect when an `EnterPlanMode` tool_use is followed by an `ExitPlanMode` (possibly with intervening read-only tool calls). Replace the contiguous group with a single `plan_mode` block.

The `plan` text comes from `EnterPlanMode.input.plan` (string). The `planFilePath` may come from `ExitPlanMode.input.path` if present. Status is `approved` if `ExitPlanMode` has a successful tool_result, `pending` if no result yet.

**Step 2: Write parser test**

Add a fixture session JSONL with `EnterPlanMode` → 2× `Read` → `ExitPlanMode` and assert one `plan_mode` block with the correct plan text and embedded tool calls.

**Step 3: Create PlanModeBlock component**

```typescript
// src/components/timeline/PlanModeBlock.tsx
import { memo, useState } from "react"
import { ChevronRight, ChevronDown, NotebookPen, CheckCircle, Clock } from "lucide-react"
import type { ToolCall } from "@/lib/types"
import { ToolCallCard } from "./ToolCallCard"
import { cn } from "@/lib/utils"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { markdownComponents } from "./markdown-components"

interface Props {
  plan: string
  planFilePath?: string
  status: "pending" | "approved" | "rejected"
  toolCalls: ToolCall[]
}

export const PlanModeBlock = memo(function PlanModeBlock({ plan, planFilePath, status, toolCalls }: Props) {
  const [open, setOpen] = useState(true)
  const [callsOpen, setCallsOpen] = useState(false)
  const Icon = status === "approved" ? CheckCircle : Clock
  const Chev = open ? ChevronDown : ChevronRight
  return (
    <div className={cn("my-2 rounded-lg border", status === "approved" ? "border-purple-500/20 bg-purple-950/5" : "border-amber-500/20 bg-amber-950/5")}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left p-2">
        <Chev className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <NotebookPen className="w-4 h-4 text-purple-400" />
        <span className="text-sm font-medium">Plan Mode</span>
        <Icon className={cn("w-4 h-4", status === "approved" ? "text-green-500/60" : "text-amber-400")} />
        <span className="text-xs text-muted-foreground capitalize">{status}</span>
        {planFilePath && <span className="text-[10px] text-muted-foreground/50 font-mono ml-auto truncate">{planFilePath}</span>}
      </button>
      {open && (
        <div className="px-3 pb-2">
          <div className="prose prose-sm dark:prose-invert max-w-none border-t border-purple-500/10 pt-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{plan}</ReactMarkdown>
          </div>
          {toolCalls.length > 0 && (
            <div className="mt-2">
              <button onClick={() => setCallsOpen(!callsOpen)} className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                {callsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {toolCalls.length} read-only call{toolCalls.length === 1 ? "" : "s"} during planning
              </button>
              {callsOpen && (
                <div className="mt-1 ml-4 space-y-1">
                  {toolCalls.map(tc => <ToolCallCard key={tc.id} toolCall={tc} expandAll={false} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
```

**Step 4: Dispatch in TurnSection**

Add a case for `kind === "plan_mode"` rendering `<PlanModeBlock {...block} />`.

**Step 5: Test**

Add render test asserting the plan markdown is rendered, status icon matches, and embedded tool calls are collapsed by default.

**Step 6: Run + commit**
```bash
bun run test src/lib src/components/timeline
bun run typecheck && bun run lint
git add src/lib/types.ts src/lib/turnBuilder.ts src/lib/__tests__ src/components/timeline/PlanModeBlock.tsx src/components/timeline/TurnSection.tsx src/components/timeline/__tests__
git commit -m "feat(timeline): first-class plan mode rendering with embedded markdown"
```

---

## Task 6: Skill tool special rendering

**Why:** Since 2.1.108, the model invokes skills via the `Skill` tool. Currently rendered as generic — should show the skill name, source, and link to SKILL.md.

**Files:**
- Modify: `src/components/timeline/ToolCallCard.tsx` (Skill renderer specialization)
- Reference: `server/routes/slash-suggestions.ts` (already discovers skills)

**Step 1: Read existing skill discovery**
```bash
# Confirm what data the API returns
fgrep -A 20 "interface SlashSuggestion" /Users/gentritbiba/agent-window/server/routes/slash-suggestions.ts
```

**Step 2: Add a skill metadata hook**

Create `src/hooks/useSkillMetadata.ts` that calls `GET /api/slash-suggestions?cwd=<cwd>` and returns a `Map<string, { source: string; description?: string; filePath?: string }>` keyed by skill name. Cache the result for 5 minutes.

**Step 3: Specialize Skill rendering in ToolCallCard**

In `ToolCallCard.tsx`, add a branch when `toolCall.name === "Skill"`:
- Show the skill name as the summary
- If metadata is available, append `· source: <source>` next to the badge
- If `filePath` is known, render a small "Open SKILL.md" link that uses the `POST /api/open-in-editor` endpoint

Keep the implementation minimal — just enough that Skill calls have visual distinction.

**Step 4: Test**
Snapshot or render test confirming the Skill badge shows the skill name and (when metadata present) the source.

**Step 5: Commit**
```bash
git add src/components/timeline/ToolCallCard.tsx src/hooks/useSkillMetadata.ts src/hooks/__tests__/useSkillMetadata.test.ts
git commit -m "feat(timeline): specialize Skill tool rendering with source + SKILL.md link"
```

---

## Task 7: Statusline state header

**Why:** Show effort level, thinking enabled, model, cache hit ratio, optional rate limits — at a glance.

**Files:**
- Create: `src/components/SessionStatusBar.tsx`
- Modify: `src/App.tsx` or wherever `<TurnSection>` is mounted (place above the timeline)
- Modify: `src/lib/turnBuilder.ts` to expose effort/thinking metadata at the session level

**Step 1: Detect effort + thinking metadata**

Effort is currently in `sdk-session.ts` for live sessions. For on-disk sessions, the effort comes from the assistant message content via `output_config.effort` (in API request body, not always in JSONL). For now, derive what's available:
- `model` from latest `assistant.message.model`
- `thinkingEnabled` from presence of `thinking` blocks in the latest turn
- `effort` from session-level state if known (via `sdk-session.ts` for live sessions only)

**Step 2: Create SessionStatusBar**

```typescript
// src/components/SessionStatusBar.tsx
import { memo } from "react"
import { Brain, Zap, GitBranch } from "lucide-react"
import type { ParsedSession } from "@/lib/types"

interface Props {
  session: ParsedSession
  effort?: string
  thinkingEnabled?: boolean
  worktreePath?: string
}

export const SessionStatusBar = memo(function SessionStatusBar({ session, effort, thinkingEnabled, worktreePath }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/40 bg-elevation-0/50 text-[11px] font-mono">
      {session.model && <span className="text-foreground/80">{session.model}</span>}
      {effort && (
        <span className="flex items-center gap-1 text-amber-400">
          <Zap className="w-3 h-3" />
          {effort}
        </span>
      )}
      {thinkingEnabled && (
        <span className="flex items-center gap-1 text-purple-400">
          <Brain className="w-3 h-3" />
          thinking
        </span>
      )}
      {worktreePath && (
        <span className="flex items-center gap-1 text-emerald-400 truncate">
          <GitBranch className="w-3 h-3" />
          {worktreePath}
        </span>
      )}
      {session.gitBranch && (
        <span className="text-muted-foreground ml-auto truncate">{session.gitBranch}</span>
      )}
    </div>
  )
})
```

**Step 3: Mount above timeline**

Find where the timeline is mounted (App.tsx or similar) and place `<SessionStatusBar />` above it. Pull effort/thinking from the live SDK state if available (`useSdkSession` hook).

**Step 4: Test**
Render test confirming each prop conditionally appears.

**Step 5: Commit**
```bash
git add src/components/SessionStatusBar.tsx src/App.tsx src/components/__tests__/SessionStatusBar.test.tsx
git commit -m "feat(ui): add session status bar showing model/effort/thinking/worktree"
```

---

## Task 8: Recap banner

**Why:** Since 2.1.108, sessions can have `/recap` and away-summary content. Show as a banner at the top of resumed turns.

**Files:**
- Create: `src/components/timeline/RecapBanner.tsx`
- Modify: `src/lib/turnBuilder.ts` — detect recap system messages
- Modify: `src/components/timeline/TurnSection.tsx`

**Step 1: Identify recap shape**

Recap content arrives as `system` messages with `subtype === "recap"` or via custom marker. Check fixtures or recent sessions:
```bash
fgrep -l '"subtype":"recap"' ~/.claude/projects/*/*.jsonl | head -3
```

**Step 2: Add `recap` to `TurnContentBlock`**
```typescript
  | { kind: "recap"; content: string; timestamp?: string }
```

**Step 3: Parse**
In `turnBuilder.ts`, detect `system` messages with `subtype === "recap"` (or whatever the actual subtype is — verify in step 1) and emit a `recap` content block.

**Step 4: Render**
A `RecapBanner` component that's small, dismissable, with markdown content.

**Step 5: Test + commit**
```bash
git add src/lib src/components/timeline/RecapBanner.tsx src/components/timeline/TurnSection.tsx
git commit -m "feat(timeline): show recap banner for /recap and away-summary content"
```

---

## Task 9: Theme directory awareness in config browser

**Why:** Since 2.1.118, themes are JSON files in `~/.claude/themes/`. Plugins can also ship themes. Add to config browser tree.

**Files:**
- Modify: `server/routes/config-browser/configTree.ts:113-204`
- Modify: `src/components/ConfigBrowser` (or wherever the tree is rendered) — verify

**Step 1: Read configTree.ts to understand current tree shape**

**Step 2: Add a `themes/` node**
- Global: `~/.claude/themes/*.json` → tree node "Themes"
- Plugin: `<plugin>/themes/*.json` → already-walked plugin tree, add themes alongside skills/commands

**Step 3: Test**
Add a vitest test that creates a fixture `themes/` dir and asserts the tree includes it.

**Step 4: Commit**
```bash
git add server/routes/config-browser/configTree.ts server/__tests__
git commit -m "feat(config-browser): expose ~/.claude/themes and plugin themes/"
```

---

## Task 10: Plugin manifest — themes, monitors, bin/

**Why:** Plugins can now ship `themes/`, `monitors/` (auto-arming background monitors), and `bin/` (executables). Currently the config browser only walks `skills/`, `commands/`, `agents/`.

**Files:**
- Modify: `server/routes/config-browser/configTree.ts:113-204` (extend plugin walk)
- Modify: `server/routes/slash-suggestions.ts` if monitors should appear in suggestions

**Step 1: Extend plugin walk**

For each plugin in `installed_plugins.json`, additionally walk:
- `<installPath>/themes/*.json`
- `<installPath>/monitors/` (each subdir is a monitor; SKILL.md may not exist — use `manifest.json` or directory name)
- `<installPath>/bin/` (list executables)

**Step 2: Test + commit**
```bash
git add server/routes/config-browser/configTree.ts
git commit -m "feat(config-browser): walk plugin themes/, monitors/, and bin/ directories"
```

---

## Task 11: PostToolUse updatedToolOutput indicator

**Why:** Since 2.1.121, hooks can replace tool output. Users should see when this happens.

**Files:**
- Modify: `src/lib/turnBuilder.ts` — when a `PostToolUse` hook event has `hookSpecificOutput.updatedToolOutput`, mark the corresponding `ToolCall` with `outputReplacedByHook: true`
- Modify: `src/lib/types.ts` — extend `ToolCall` interface
- Modify: `src/components/timeline/ToolCallCard.tsx` — show a small "hook" badge

**Step 1: Extend ToolCall type**
```typescript
export interface ToolCall {
  // existing fields
  /** Set by parser when a PostToolUse hook replaced this tool's output */
  outputReplacedByHook?: boolean
  /** PostToolUse hook execution duration */
  hookDurationMs?: number
}
```

**Step 2: Cross-link in parser**
In `turnBuilder.ts`, after parsing a hook event with `tool_use_id`, find the matching `ToolCall` and set the flag.

**Step 3: Render in card**
Next to `StatusIcon`, show `<span title="Output replaced by hook" className="text-[10px] text-blue-400">hook</span>` when `outputReplacedByHook`.

**Step 4: Test + commit**
```bash
git add src/lib src/components/timeline/ToolCallCard.tsx
git commit -m "feat(timeline): annotate tool calls when PostToolUse hook replaces output"
```

---

## Task 12: AskUserQuestion interactive UI (live sessions only)

**Why:** Today the AskUserQuestion summary is shown but the user has to go back to the terminal to answer. The HTTP API already has `POST /api/permissions` for live sessions — mirror that for AskUserQuestion.

**Files:**
- Create: `server/routes/ask-user.ts` (POST /api/ask-user-answer)
- Register in: `server/api-plugin.ts` AND `electron/server.ts` (per project CLAUDE.md, both are required)
- Modify: `src/components/timeline/ToolCallCard.tsx` — render an inline form for live AskUserQuestion calls

**Step 1: Backend route**

Mirror the permissions route. Accept `{ toolUseId: string, answers: string[] | Record<string, string> }`. Inject the answer into the live SDK session via `sdk-session.ts`.

**Step 2: Frontend inline form**

When `toolCall.name === "AskUserQuestion"` AND result is null AND `isAgentActive`, render a form with the questions extracted from `input.questions`. Submit calls the new endpoint.

**Step 3: Tests**

Backend test for the route, frontend test for the form rendering.

**Step 4: Register on both servers**

Add to BOTH `server/api-plugin.ts` and `electron/server.ts` — per project CLAUDE.md, registering only one means dev or production breaks.

**Step 5: Commit**
```bash
git add server/routes/ask-user.ts server/api-plugin.ts electron/server.ts src/components/timeline/ToolCallCard.tsx server/__tests__ src/components/timeline/__tests__
git commit -m "feat(api): inline AskUserQuestion answering for live sessions"
```

---

## Task 13: Permission `defer` decision detection

**Why:** Since 2.1.89, headless sessions can pause on tool calls and resume via `-p --resume`. A dashboard should detect deferred sessions and offer to resume them.

**Files:**
- Modify: `server/routes/active-sessions.ts` (or wherever active sessions are listed) — detect deferred state
- Modify: `src/components` running-processes panel to show "deferred" status

**Step 1: Identify deferred state in JSONL**

A session in deferred state has its last `progress` event with `decision: "defer"` from a `PreToolUse` hook. Search:
```bash
fgrep -l '"decision":"defer"' ~/.claude/projects/*/*.jsonl | head -1
```

**Step 2: Surface as session metadata**

In the parser/sessionStatus utility, expose `isDeferred: boolean`. In the active-sessions API response, include this field.

**Step 3: UI**

In the running-processes panel, when `isDeferred`, show an amber "deferred" pill and a "Resume to evaluate" button that calls `claude -p --resume <id>` via the existing `POST /api/scripts` endpoint.

**Step 4: Test + commit**
```bash
git add src/lib/sessionStatus.ts server/routes src/components
git commit -m "feat(sessions): detect and resume permission-deferred sessions"
```

---

## Task 14: Final review

**Why:** Catch any cross-task regressions before merging.

**Step 1: Full test suite**
```bash
bun run test
bun run typecheck
bun run lint
```

**Step 2: Spot-check on a real session**

```bash
bun run dev
```
Open the dashboard, open a recent Claude Code session that includes hook events. Verify:
- Hook event chips appear at correct positions
- New tool summaries render correctly
- Plan mode blocks render (if any plan-mode session exists)
- Status bar shows model/effort/thinking
- No console errors

**Step 3: Lint + typecheck final pass**

**Step 4: Summarize the work and present completion options**

After all 13 implementation tasks land, dispatch a final code-reviewer subagent to validate the entire batch against this plan.

---

## Out-of-scope follow-ups (Tier 3 deferred)

These are intentionally NOT in this plan but listed for future work:
- `EnterWorktree` `path` parameter handling beyond summary text
- `--bare -p` mode flag in session metadata
- `/usage` endpoint mirror with new merged data shape
- Voice mode metadata icons
- `claude project purge` integration
- `/ultrareview` / `/ultraplan` cloud session linkage
- `prUrlTemplate` setting wiring
- `skillOverrides` setting filtering
- Effort-aware skill frontmatter rendering

These can be opened as separate plans once Tier 1+2 land.
