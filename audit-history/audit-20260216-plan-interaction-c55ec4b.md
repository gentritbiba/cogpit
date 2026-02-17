# Audit Report — 2026-02-16

## Commit: f143f75 (+ uncommitted refinement to parser.ts)

## Summary of Changes

Interactive plan mode and user question detection feature. When a session has a pending `ExitPlanMode` or `AskUserQuestion` tool call, the chat input area transforms to show contextual UI bars. This builds on the plan mode detection types introduced in commit f8b0c56 and refines the detection logic to handle Claude Code's intermediate error results correctly.

## Detailed Findings

### 1. Refined detectPendingInteraction() Logic
**File:** `src/lib/parser.ts` (lines 609-641, uncommitted change)

**Changes:**
- Previous logic: returned `null` if `lastToolCall.result !== null` (any result meant interaction was handled)
- New logic: first checks if tool is `ExitPlanMode` or `AskUserQuestion` (returns `null` early for other tools), then only considers the interaction resolved if the result is non-null AND non-error
- Accounts for Claude Code writing an immediate error `tool_result` containing permission prompt text while the interaction is still pending
- A successful (non-error) result means the user actually responded

**Public API Impact:** YES — Changes behavior of existing public function `detectPendingInteraction()`

**Documentation Needed:**
- The prior audit report (audit-20260216-225630-f8b0c56.md) already documented the function and its types
- The behavioral refinement (error results vs. successful results) should be noted if API docs are written
- Key detail: "An error tool_result does NOT mean the interaction is complete; Claude Code uses error results for permission prompt text while waiting"

---

### 2. PlanApprovalBar Sub-Component
**File:** `src/components/ChatInput.tsx` (lines 340-395)

**Changes:**
- New internal `PlanApprovalBar` component rendered when `pendingInteraction.type === "plan"`
- Purple-themed bar with CheckCircle icon and "Plan ready for review" label
- "Approve" button sends `"yes"` via `onSend`; "Reject" button sends `"no"`
- Optionally displays `allowedPrompts` as permission badges when present

**Public API Impact:** NO — Internal sub-component of ChatInput, not exported

**Documentation Needed:** NO — UI implementation detail

---

### 3. UserQuestionBar Sub-Component
**File:** `src/components/ChatInput.tsx` (lines 397-450)

**Changes:**
- New internal `UserQuestionBar` component rendered when `pendingInteraction.type === "question"`
- Pink-themed bar with MessageSquare icon
- Displays first question's header and text
- Renders clickable option buttons; clicking an option sends `opt.label` via `onSend`
- Options with descriptions show tooltips on hover
- Textarea placeholder changes to "Type a custom response..." when active

**Public API Impact:** NO — Internal sub-component of ChatInput, not exported

**Documentation Needed:** NO — UI implementation detail

---

### 4. ChatInput Textarea Theming by Interaction State
**File:** `src/components/ChatInput.tsx` (lines 166-224)

**Changes:**
- Textarea border and focus ring colors change based on interaction state:
  - Plan approval: purple border (`border-purple-700/50`, `focus:ring-purple-500/20`)
  - User question: pink border (`border-pink-700/50`, `focus:ring-pink-500/20`)
  - Default: blue border (unchanged)
- Green connection indicator hidden during plan approval or question states
- Placeholder text changes contextually:
  - Plan: "Provide feedback to request changes..."
  - Question: "Type a custom response..."
  - Connected: "Message... (Enter to send)"

**Public API Impact:** NO — Visual changes only

**Documentation Needed:** NO

---

### 5. ToolCallCard Badge Styles and Summaries
**File:** `src/components/timeline/ToolCallCard.tsx` (lines 13-76)

**Changes:**
- Three new entries in `TOOL_BADGE_STYLES`:
  - `EnterPlanMode`: purple badge (`bg-purple-500/20 text-purple-400 border-purple-500/30`)
  - `ExitPlanMode`: purple badge (same styling)
  - `AskUserQuestion`: pink badge (`bg-pink-500/20 text-pink-400 border-pink-500/30`)
- `getToolSummary()` extended with three new cases:
  - `EnterPlanMode` returns "Entered plan mode"
  - `ExitPlanMode` returns "Waiting for plan approval"
  - `AskUserQuestion` extracts and returns first question text from input

**Public API Impact:** NO — Internal styling and summary logic

**Documentation Needed:** NO

---

### 6. Tool Colors in Parser
**File:** `src/lib/parser.ts` (lines 571-573)

**Changes:**
- Three new entries in `TOOL_COLORS` map:
  - `EnterPlanMode: "text-purple-400"`
  - `ExitPlanMode: "text-purple-400"`
  - `AskUserQuestion: "text-pink-400"`

**Public API Impact:** NO — `getToolColor()` function behavior extended but API unchanged

**Documentation Needed:** NO

---

### 7. App.tsx Wiring
**File:** `src/App.tsx` (lines 49, 79-81, 450, 786)

**Changes:**
- Imports `detectPendingInteraction` from parser
- Computes `pendingInteraction` via `useMemo` from `state.session`
- Passes `pendingInteraction` prop to `ChatInput` in both desktop (line 450) and mobile (line 786) layouts

**Public API Impact:** NO — Application wiring only

**Documentation Needed:** NO

---

## Documentation Status

**Existing Documentation:**
- `docs/plans/2026-02-16-pty-interactive-chat.md`: Design plan for PTY-based chat. Does NOT mention plan mode or user question detection. **No update needed** — this plan covers the PTY/chat infrastructure, not interactive features. The interactive bars are an enhancement to ChatInput that doesn't change the plan's scope.
- `docs/plans/2026-02-16-undo-redo-branching-design.md`: Undo/redo design document. **No update needed** — completely unrelated to this feature.
- `docs/plans/2026-02-16-undo-redo-branching-plan.md`: Undo/redo implementation plan. **No update needed** — completely unrelated.
- No project-level README.md exists.

**Documentation Changes Required:** None.

All changes are either:
1. Internal UI sub-components (PlanApprovalBar, UserQuestionBar) that are not exported
2. Visual styling additions (badge colors, tool summaries) with no API contract change
3. A behavioral refinement to `detectPendingInteraction()` that was already documented in the prior audit report (f8b0c56)

The prior audit report (audit-20260216-225630-f8b0c56.md, Section 6) already thoroughly documents the `PendingInteraction` type, its variants, and the `detectPendingInteraction()` function. The current change refines detection behavior but does not change the public type signatures.

---

## Breaking Changes

None. All changes are additive or behavioral refinements to existing internal components.

---

## Backward Compatibility Notes

- `detectPendingInteraction()` now returns interaction states for `ExitPlanMode`/`AskUserQuestion` tool calls that have error results (previously returned `null`). This is a behavioral correction, not a breaking change, since the previous behavior was a bug (treating permission prompt errors as completed interactions).
- `ChatInput` accepts `pendingInteraction` as an optional prop; omitting it preserves prior behavior.

---

## Issues Found During Review

1. **Semantic note**: The `detectPendingInteraction()` function previously had overly broad null-check logic (`result !== null` for any tool). The uncommitted change correctly narrows this to only check interactive tools and distinguishes error results from successful results. This is a bug fix rather than a feature change.

---

## Action Items

1. **LOW PRIORITY**: If formal API docs are created for `detectPendingInteraction()`, note the error-result vs. successful-result distinction
   - Error `tool_result` = interaction still pending (Claude Code permission prompt)
   - Non-error `tool_result` = user responded, interaction complete

---

## Bloat Reduction Opportunities

No documentation bloat identified. Existing docs remain focused and relevant.

---

## Summary for Changelog

**New Features:**
- Interactive plan approval bar in chat input (purple theme, Approve/Reject buttons)
- Interactive user question bar in chat input (pink theme, clickable option buttons)
- Contextual textarea theming and placeholder text for interactive states
- Tool call card badges and summaries for EnterPlanMode, ExitPlanMode, AskUserQuestion

**Bug Fixes:**
- `detectPendingInteraction()` now correctly treats error tool_results as pending (permission prompt text) rather than completed interactions
