import type { TurnContentBlock } from "@/lib/types"
import { formatDuration } from "@/lib/format"

/** Which blocks a turn hides behind its work disclosure. */
export interface FoldPlan {
  /** Indices into `contentBlocks` that disappear while the turn is folded. */
  foldedIndices: number[]
  /** Where the fold control renders, so hidden work collapses in place. */
  foldAnchorIndex: number
  /** False when folding would hide everything, or hide nothing worth hiding. */
  foldable: boolean
  /** Tool calls behind the fold, used to label turns with no measured duration. */
  hiddenToolCalls: number
}

/**
 * Blocks that stay put no matter what. These are things the user wrote, decided
 * on, or asked for — hiding them behind a "work" control would misfile them as
 * process.
 */
const PINNED_KINDS: ReadonlySet<TurnContentBlock["kind"]> = new Set([
  "queued_prompt",
  "plan_mode",
  "recap",
])

/** Blocks that represent the agent working rather than answering. */
const WORK_KINDS: ReadonlySet<TurnContentBlock["kind"]> = new Set([
  "thinking",
  "tool_calls",
  "sub_agent",
  "background_agent",
  "hook_event",
])

/** Tools that stop the turn and hand control to the user. */
const INTERACTIVE_TOOLS: ReadonlySet<string> = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
])

/** Assistant output that proves the agent moved on past an earlier block. */
const CONTINUATION_KINDS: ReadonlySet<TurnContentBlock["kind"]> = new Set([
  "text",
  "thinking",
  "tool_calls",
])

function holdsUnansweredPrompt(block: TurnContentBlock): boolean {
  return block.kind === "tool_calls" && block.toolCalls.some(
    (toolCall) => INTERACTIVE_TOOLS.has(toolCall.name) && toolCall.result == null,
  )
}

/**
 * Index of the block holding a prompt the turn is still blocked on, or -1.
 *
 * A blocked session writes nothing further to its JSONL, so the stream goes
 * quiet and the turn reads as settled roughly half a minute later. Folding then
 * files the prompt under finished work and hides the answer form, while the
 * status line — which reads the parsed session rather than liveness — still
 * says the session is waiting. Deciding this from the blocks themselves is what
 * stops any caller from losing the prompt by mistaking silence for done.
 *
 * Assistant content after the prompt means the agent gave up on it, the same
 * test `detectPendingInteraction` applies, so only a turn that ENDS on an open
 * prompt is pinned.
 */
function findBlockingPromptIndex(blocks: TurnContentBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (holdsUnansweredPrompt(blocks[i])) return i
    if (CONTINUATION_KINDS.has(blocks[i].kind)) return -1
  }
  return -1
}

const EMPTY_PLAN: FoldPlan = {
  foldedIndices: [],
  foldAnchorIndex: -1,
  foldable: false,
  hiddenToolCalls: 0,
}

export function planTurnFold(
  blocks: TurnContentBlock[],
  phase: "working" | "settled" = "settled",
): FoldPlan {
  if (blocks.length === 0) return EMPTY_PLAN

  // Without work there is nothing to fold: a run of text blocks is one long
  // answer, not commentary wrapped around tool calls.
  if (!blocks.some((block) => WORK_KINDS.has(block.kind))) return EMPTY_PLAN

  let terminalTextIndex = -1
  if (phase === "settled") {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === "text") {
        terminalTextIndex = i
        break
      }
    }
    // An interrupted turn has no final answer to leave visible.
    if (terminalTextIndex === -1) return EMPTY_PLAN
  }

  const blockingPromptIndex = findBlockingPromptIndex(blocks)
  const foldedIndices: number[] = []
  let hiddenToolCalls = 0

  for (let i = 0; i < blocks.length; i++) {
    if (i === terminalTextIndex || i === blockingPromptIndex) continue
    const block = blocks[i]
    if (PINNED_KINDS.has(block.kind)) continue

    foldedIndices.push(i)
    if (block.kind === "tool_calls") hiddenToolCalls += block.toolCalls.length
  }

  if (foldedIndices.length === 0) return EMPTY_PLAN

  return {
    foldedIndices,
    foldAnchorIndex: foldedIndices[0],
    foldable: true,
    hiddenToolCalls,
  }
}

/** The one line a folded turn shows in place of its work. */
export function turnFoldLabel(durationMs: number | null, hiddenToolCalls: number): string {
  if (durationMs !== null && durationMs > 0) return `Worked for ${formatDuration(durationMs)}`
  if (hiddenToolCalls > 0) {
    return `Worked through ${hiddenToolCalls} step${hiddenToolCalls === 1 ? "" : "s"}`
  }
  return "Show work"
}
