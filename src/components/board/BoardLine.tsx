import { ChevronUp } from "lucide-react"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { useSessionBoard } from "@/hooks/useSessionBoard"
import { useSessionNamer } from "@/hooks/useSessionNamer"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BoardSection } from "../../../shared/contracts/board"

const TONE_TEXT: Record<NonNullable<BoardSection["tone"]>, string> = { warning: "text-warning", success: "text-success" }
const TONE_DOT: Record<NonNullable<BoardSection["tone"]>, string> = { warning: "bg-warning", success: "bg-success" }

/**
 * The board of the open session's crew, pinned above the composer: one line
 * that says where the work stands, opening to its sections. Renders nothing
 * until the crew's lead keeps a board.
 */
export function BoardLine({ boardSessionId }: { boardSessionId: string | null }) {
  const board = useSessionBoard(boardSessionId)
  const nameOf = useSessionNamer()
  const [openBoards, setOpenBoards] = useLocalStorage<string[]>("board-line-open", [])
  if (!board) return null
  const expanded = Array.isArray(openBoards) ? openBoards : []
  const open = expanded.includes(board.sessionId)
  const toggle = () => setOpenBoards(open
    ? expanded.filter((id) => id !== board.sessionId)
    : [...expanded, board.sessionId])
  const keeper = nameOf(board.sessionId)
  const filled = board.sections.filter((section) => section.items.length > 0)

  return (
    <section aria-label="Board" data-board className="mx-3 overflow-hidden rounded-xl border border-border bg-card/80 text-[12.5px]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {board.title && <span className="shrink-0 font-medium text-foreground">{board.title}</span>}
        {board.progress && (
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
            <span className="h-1 w-12 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full rounded-full bg-foreground" style={{ width: `${(board.progress.done / board.progress.total) * 100}%` }} />
            </span>
            {board.progress.done} of {board.progress.total}
          </span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2.5 truncate text-muted-foreground">
          {filled.map((section) => (
            <span key={section.title} className={cn("shrink-0", section.tone && TONE_TEXT[section.tone])}>
              {section.title} <span className="font-medium tabular-nums">{section.items.length}</span>
            </span>
          ))}
        </span>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
          updated {formatRelativeTime(new Date(board.updatedAt).toISOString())}{keeper ? ` by ${keeper}` : ""}
        </span>
        <ChevronUp className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && filled.length > 0 && (
        <div className="grid border-t border-border/70 sm:grid-cols-3">
          {filled.map((section) => (
            <div key={section.title} className="min-w-0 border-border/70 px-3 py-2 sm:border-l sm:first:border-l-0">
              <h4 className={cn("mb-1 text-[11.5px] font-medium text-muted-foreground", section.tone && TONE_TEXT[section.tone])}>{section.title}</h4>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item} className="flex min-w-0 items-center gap-2">
                    <span className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground/50", section.tone && TONE_DOT[section.tone])} aria-hidden="true" />
                    <span className="truncate">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
