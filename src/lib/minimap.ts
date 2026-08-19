import type { Turn, ContentBlock } from "@/lib/types"
import {
  parseInterrupts,
  parseTaskNotifications,
  stripSystemNotificationPreamble,
  stripSystemTags,
} from "@/lib/userMessageContent"

/**
 * Below this a conversation is already visible in one or two screens, and a
 * table of contents costs more attention than it saves.
 */
export const MINIMAP_MIN_TURNS = 3

/**
 * Tick widths by distance from the hovered tick, nearest first.
 *
 * The rail is a fisheye: the tick under the cursor opens up and its neighbours
 * taper away, so a long conversation stays one narrow gutter until you reach
 * for it.
 */
const TICK_WIDTHS = ["w-6", "w-4", "w-2.5", "w-2"] as const

const RESTING_WIDTH = TICK_WIDTHS[TICK_WIDTHS.length - 1]

export function tickWidthClass(distanceFromCursor: number | null): string {
  if (distanceFromCursor === null || distanceFromCursor < 0) return RESTING_WIDTH
  return TICK_WIDTHS[Math.min(distanceFromCursor, TICK_WIDTHS.length - 1)]
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text"
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * One line of the prompt that opened a turn, for the rail's hover preview.
 *
 * Turns routinely open with machine envelopes — background-task reports, system
 * reminders, interrupt markers. A rail labelled with those is unreadable, so
 * they come off first and a task-only turn falls back to what the task reported
 * rather than to nothing.
 */
export function turnPreviewText(turn: Turn): string {
  const raw =
    typeof turn.userMessage === "string"
      ? turn.userMessage
      : Array.isArray(turn.userMessage)
        ? turn.userMessage.filter(isTextBlock).map((block) => block.text).join(" ")
        : ""

  const { text: withoutPreamble } = stripSystemNotificationPreamble(raw)
  const { notifications, remainingText } = parseTaskNotifications(withoutPreamble)
  const { remainingText: withoutInterrupts } = parseInterrupts(remainingText)

  const typed = collapse(stripSystemTags(withoutInterrupts))
  if (typed) return typed

  const reported = notifications.map((n) => n.summary).find(Boolean)
  if (reported) return collapse(reported)

  // Sessions open on meta records (custom title, agent name) that build a turn
  // carrying no prompt at all. What the agent said is a better handle than a
  // placeholder.
  const said = turn.assistantText.map(collapse).find(Boolean)
  return said || "Untitled turn"
}
