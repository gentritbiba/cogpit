import { ChevronUp } from "lucide-react"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { useSessionBoards } from "@/hooks/useSessionBoards"
import { useSessionNamer } from "@/hooks/useSessionNamer"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BoardSection } from "../../../shared/contracts/board"
import { BoardItemText } from "./BoardItemText"
import { filledSections, TONE_DOT, TONE_TEXT } from "./boardView"

/** The section open on each board: its place, with its title to find it again when sections move. */
type OpenSection = { index: number; title: string }
type OpenSections = Record<string, OpenSection>

const COUNT_TONE: Record<NonNullable<BoardSection["tone"]>, string> = {
  warning: "bg-warning/15 text-warning",
  success: "bg-success/15 text-success",
}

/**
 * The board of the open session's crew, pinned above the composer: one row of
 * its sections with their counts, each opening to its items in full. Renders
 * nothing until the crew's lead keeps a board.
 */
export function BoardLine({ boardSessionId }: { boardSessionId: string | null }) {
  const boards = useSessionBoards()
  const board = boardSessionId ? boards.get(boardSessionId) ?? null : null
  const nameOf = useSessionNamer()
  const [stored, setStored] = useLocalStorage<OpenSections>("board-line-open", {})
  if (!board) return null

  const openSections = isOpenSections(stored) ? stored : {}
  const filled = filledSections(board)
  const choice = openSections[board.sessionId]
  const active = (choice && filled[choice.index]?.title === choice.title ? filled[choice.index] : undefined)
    ?? filled.find((section) => section.title === choice?.title)
    ?? filled[0]
  const open = choice !== undefined && active !== undefined
  const show = (index: number | null) => setStored((previous) => {
    const next = { ...(isOpenSections(previous) ? previous : {}) }
    if (index === null) delete next[board.sessionId]
    else next[board.sessionId] = { index, title: filled[index].title }
    return next
  })
  const keeper = nameOf(board.sessionId)
  const panelId = `board-panel-${board.sessionId}`

  return (
    <section aria-label="Board" data-board className="mx-3 overflow-hidden rounded-xl border border-border bg-card/80">
      <div className="flex h-9 min-w-0 items-center gap-2 pl-3 pr-1">
        {board.title && <span className="min-w-0 max-w-[40%] shrink truncate text-[12.5px] font-medium text-foreground" title={board.title}>{board.title}</span>}
        {board.progress && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label={`${board.progress.done} of ${board.progress.total} done`}>
            <span className="h-1 w-10 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full rounded-full bg-foreground/80" style={{ width: `${(board.progress.done / board.progress.total) * 100}%` }} />
            </span>
            {board.progress.done}/{board.progress.total}
          </span>
        )}
        {board.title && filled.length > 0 && <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />}
        <div role="group" aria-label="Board sections" className="-ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto pl-1 pr-4 [mask-image:linear-gradient(to_right,#000_calc(100%-1rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filled.map((section, index) => {
            const selected = open && section === active
            return (
              <button
                key={index}
                type="button"
                aria-pressed={selected}
                aria-controls={selected ? panelId : undefined}
                onClick={() => show(selected ? null : index)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  section.tone && TONE_TEXT[section.tone],
                )}
              >
                {section.title}{" "}
                <span className={cn(
                  "min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums",
                  section.tone ? COUNT_TONE[section.tone] : "bg-foreground/[0.07] text-foreground/80",
                )}>
                  {section.items.length}
                </span>
              </button>
            )
          })}
        </div>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline" title={keeper ? `Kept by ${keeper}` : undefined}>
          Updated {describeUpdated(board.updatedAt)}
        </span>
        {filled.length > 0 && (
          <button
            type="button"
            onClick={() => show(open ? null : filled.indexOf(active))}
            aria-expanded={open}
            aria-label={open ? "Collapse board" : "Expand board"}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronUp className={cn("size-3.5 transition-transform", !open && "rotate-180")} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div id={panelId} role="region" aria-label={active.title} className="border-t border-border/70">
          <ul className="flex max-h-[min(40vh,320px)] flex-col overflow-y-auto py-1.5">
            {active.items.map((item, index) => (
              <li key={index} className="flex min-w-0 gap-2.5 px-3 py-1 text-[13px] leading-[1.45] text-foreground/80">
                <span
                  aria-hidden="true"
                  className={cn("mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/50", active.tone && TONE_DOT[active.tone])}
                />
                <span className="min-w-0 break-words"><BoardItemText text={item} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function isOpenSections(value: unknown): value is OpenSections {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeUpdated(updatedAt: number): string {
  const updated = formatRelativeTime(new Date(updatedAt).toISOString())
  if (updated === "now") return "just now"
  if (/^\d+[mhd]$/.test(updated)) return `${updated} ago`
  return `on ${updated}`
}
