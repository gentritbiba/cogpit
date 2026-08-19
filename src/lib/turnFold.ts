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

  const foldedIndices: number[] = []
  let hiddenToolCalls = 0

  for (let i = 0; i < blocks.length; i++) {
    if (i === terminalTextIndex) continue
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
