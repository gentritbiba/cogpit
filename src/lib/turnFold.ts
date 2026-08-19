import type { TurnContentBlock } from "@/lib/types"
import { formatDuration } from "@/lib/format"

/**
 * Which blocks a settled turn hides behind its "Worked for 47s" control.
 *
 * A finished turn is mostly process: thinking, tool calls, nested agents and the
 * commentary between them. Only the last thing the assistant said is the answer.
 * Folding the rest turns scrollback into a clean question/answer log and leaves
 * the process one click away.
 */
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

export function planTurnFold(blocks: TurnContentBlock[]): FoldPlan {
  if (blocks.length === 0) return EMPTY_PLAN

  // Without work there is nothing to fold: a run of text blocks is one long
  // answer, not commentary wrapped around tool calls.
  if (!blocks.some((block) => WORK_KINDS.has(block.kind))) return EMPTY_PLAN

  // Folding is only safe if something is left on screen afterwards. A turn that
  // ends on work was interrupted, so it stays open and the user keeps their place.
  let terminalTextIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "text") {
      terminalTextIndex = i
      break
    }
  }
  if (terminalTextIndex === -1) return EMPTY_PLAN

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
