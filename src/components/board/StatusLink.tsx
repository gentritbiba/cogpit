import { ListChecks } from "lucide-react"
import { useSessionBoards } from "@/hooks/useSessionBoards"
import { cn } from "@/lib/utils"
import { filledSections, needsYouCount, needsYouLabel } from "./boardView"
import type { ListedBoard } from "../../../shared/contracts/board"
import { useStatusPanel } from "./StatusPanelContext"

/** The board a session's link opens, or null where it keeps none or the layout has no status panel. */
export function useStatusLinkBoard(sessionId: string): ListedBoard | null {
  const statusPanel = useStatusPanel()
  const board = useSessionBoards().get(sessionId)
  return statusPanel && board ? board : null
}

/**
 * A listed session's status in one line under its card, opening the status
 * panel on it without opening the conversation.
 */
export function SessionStatusLine({ board }: { board: ListedBoard }) {
  const statusPanel = useStatusPanel()
  if (!statusPanel) return null
  const title = board.title ?? filledSections(board)[0]?.title ?? "Status"
  const needsYou = needsYouCount(board)
  return (
    <button
      type="button"
      data-session-status={board.sessionId}
      onClick={() => statusPanel.open(board.sessionId)}
      aria-label={`Show status: ${title}`}
      className="-mt-1 mb-2 ml-[26px] mr-3 flex min-w-0 items-center gap-1.5 rounded-sm text-left text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ListChecks aria-hidden="true" className={cn("size-3 shrink-0", needsYou > 0 && "text-warning")} />
      <span className="min-w-0 flex-1 truncate text-foreground/90">{title}</span>
      {board.progress && <span className="shrink-0 tabular-nums">{board.progress.done}/{board.progress.total}</span>}
      {needsYou > 0 && <span className="shrink-0 tabular-nums text-warning">{needsYouLabel(needsYou)}</span>}
    </button>
  )
}

/** A crew member's status as a small button beside its row. Nothing until it keeps one. */
export function MemberStatusButton({ sessionId, name }: { sessionId: string; name: string }) {
  const statusPanel = useStatusPanel()
  const board = useStatusLinkBoard(sessionId)
  if (!statusPanel || !board) return null
  const needsYou = needsYouCount(board)
  return (
    <button
      type="button"
      data-member-status={sessionId}
      onClick={() => statusPanel.open(sessionId)}
      aria-label={`Show the status of ${name}`}
      title={board.title ?? "Status"}
      className="flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-[11px] tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ListChecks aria-hidden="true" className={cn("size-3", needsYou > 0 && "text-warning")} />
      {board.progress && `${board.progress.done}/${board.progress.total}`}
    </button>
  )
}
