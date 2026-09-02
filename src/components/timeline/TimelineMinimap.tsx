import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { MINIMAP_MIN_TURNS, tickWidthClass, turnPreviewText } from "@/lib/minimap"
import type { Turn } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * A table of contents for the conversation: one tick per turn, down the gutter.
 *
 * The rail is a fisheye — the tick under the cursor opens up and its neighbours
 * taper — so it stays a hairline until you reach for it. Following the scroll
 * writes a data attribute straight onto the ticks rather than setting state,
 * because the transcript is usually streaming while the user scrolls it.
 */
export const TimelineMinimap = memo(function TimelineMinimap({
  turns,
  scrollContainerRef,
  onJumpToTurn,
}: {
  turns: Turn[]
  scrollContainerRef: RefObject<HTMLElement | null>
  onJumpToTurn: (index: number) => void
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const railRef = useRef<HTMLElement>(null)
  const turnCount = turns.length
  const turnKeys = useMemo(() => {
    const occurrences = new Map<string, number>()
    return turns.map((turn) => {
      const occurrence = occurrences.get(turn.id) ?? 0
      occurrences.set(turn.id, occurrence + 1)
      return occurrence === 0 ? turn.id : `${turn.id}#${occurrence}`
    })
  }, [turns])

  useEffect(() => {
    const scroller = scrollContainerRef.current
    const rail = railRef.current
    if (!scroller || !rail) return

    let frame: number | null = null
    const paint = () => {
      frame = null
      const midpoint = scroller.getBoundingClientRect().top + scroller.clientHeight / 2
      let current: number | null = null
      // Virtualisation keeps the mounted turn set small, so this stays cheap.
      for (const el of scroller.querySelectorAll<HTMLElement>("[data-turn-index]")) {
        const rect = el.getBoundingClientRect()
        if (rect.top <= midpoint && rect.bottom >= midpoint) {
          current = Number(el.dataset.turnIndex)
          break
        }
      }
      for (const tick of rail.querySelectorAll<HTMLElement>("[data-tick-index]")) {
        tick.dataset.current = String(Number(tick.dataset.tickIndex) === current)
      }
    }

    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(paint)
    }

    paint()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [scrollContainerRef, turnCount])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
    const rail = railRef.current
    if (!rail) return

    const ticks = [...rail.querySelectorAll<HTMLButtonElement>("[data-tick-index]")]
    if (ticks.length === 0) return

    let target: HTMLButtonElement | undefined
    if (step !== 0) {
      const active = ticks.indexOf(document.activeElement as HTMLButtonElement)
      target = ticks[Math.min(Math.max(active + step, 0), ticks.length - 1)]
    } else if (event.key === "Home") {
      target = ticks[0]
    } else if (event.key === "End") {
      target = ticks[ticks.length - 1]
    }

    if (!target) return
    event.preventDefault()
    target.focus()
  }, [])

  if (turnCount < MINIMAP_MIN_TURNS) return null

  return (
    <nav
      ref={railRef}
      aria-label="Conversation timeline"
      onMouseLeave={() => setHovered(null)}
      onKeyDown={handleKeyDown}
      className={cn(
        "absolute left-0 top-0 hidden h-full max-h-full flex-col items-start gap-1",
        // Spread across the height so the rail reads as a contents column rather
        // than a cluster of marks; once the ticks fill it they pack and scroll.
        "justify-evenly overflow-y-auto pb-6 pl-2 pt-14",
        "opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100",
        // A coarse pointer cannot hover a 4px rail, and the phone shell has its
        // own navigation.
        "[@media(pointer:fine)]:flex",
      )}
    >
      {turns.map((turn, index) => {
        const preview = turnPreviewText(turn)
        return (
          <Button
            key={turnKeys[index]}
            type="button"
            variant="ghost"
            data-tick-index={index}
            onMouseEnter={() => setHovered(index)}
            onFocus={() => setHovered(index)}
            onClick={() => onJumpToTurn(index)}
            aria-label={`Turn ${index + 1}: ${preview}`}
            className={cn(
              "group/tick relative h-1 shrink-0 rounded-full bg-muted-foreground/30 p-0",
              "transition-[width,background-color] duration-150 motion-reduce:transition-none",
              "hover:bg-muted-foreground/80 focus-visible:outline-none focus-visible:bg-muted-foreground/80",
              "data-[current=true]:bg-primary/70",
              tickWidthClass(hovered === null ? null : Math.abs(index - hovered)),
            )}
          >
            <span
              className={cn(
                "pointer-events-none absolute left-full top-1/2 ml-2 hidden w-64 -translate-y-1/2",
                "rounded-md border bg-popover px-2 py-1.5 text-left",
                "text-xs leading-relaxed text-popover-foreground shadow-sm",
                "group-hover/tick:block group-focus-visible/tick:block",
              )}
            >
              <span className="mr-1 font-mono text-muted-foreground/60">{index + 1}</span>
              <span className="line-clamp-2 align-middle">{preview}</span>
            </span>
          </Button>
        )
      })}
    </nav>
  )
})
