import type { BoardSection, SessionBoard } from "../../../shared/contracts/board"

export const TONE_TEXT: Record<NonNullable<BoardSection["tone"]>, string> = { warning: "text-warning", success: "text-success" }
export const TONE_DOT: Record<NonNullable<BoardSection["tone"]>, string> = { warning: "bg-warning", success: "bg-success" }

const TONE_ORDER = { warning: 0, none: 1, success: 2 } as const

/** The sections that say something, what needs the user first and what landed last. */
export function filledSections(board: SessionBoard): BoardSection[] {
  return board.sections
    .filter((section) => section.items.length > 0)
    .map((section, index) => ({ section, index }))
    .sort((a, b) => TONE_ORDER[a.section.tone ?? "none"] - TONE_ORDER[b.section.tone ?? "none"] || a.index - b.index)
    .map(({ section }) => section)
}

/** How many items the board says wait on the user. */
export function needsYouCount(board: SessionBoard): number {
  return board.sections.reduce((count, section) => count + (section.tone === "warning" ? section.items.length : 0), 0)
}

/** "1 needs you", "3 need you". */
export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`
}
