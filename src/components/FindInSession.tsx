import { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle, type RefObject } from "react"
import { X, ChevronUp, ChevronDown, History, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { useSessionContext } from "@/contexts/SessionContext"
import { openWorkFoldFor, revealKey, revealToolCall, useTimelineStore, type TimelineStateStore } from "@/components/timeline/disclosure"
import { findInTurns, turnSegments, type FindHit, type FindPart } from "@/lib/sessionFind"
import { activeScopeRanges, FindPainter, rangeElement, type ActiveMatch } from "@/lib/sessionFindDom"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"
import type { TimelineHandle } from "@/lib/timelineScroll/types"
import { QUOTE_SEARCH_PAGES } from "@/hooks/useQuoteNavigation"
import type { Turn } from "../../shared/session/types"

export interface FindInSessionHandle {
  open: () => void
  close: () => void
  isOpen: boolean
}

interface FindInSessionProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>
  timelineRef: RefObject<TimelineHandle | null>
  hasMore?: boolean
  isLoadingOlder?: boolean
  onLoadMore?: () => void
}

const NO_TURNS: Turn[] = []
const NO_HITS: FindHit[] = []
/** Landing attempts that may wait for revealed content before settling for the closest occurrence. */
const SETTLE_ATTEMPTS = 4
/** Disclosures that only shorten long text, opened when the match lies past the cut. */
const LENGTH_DISCLOSURE = /:(user:more|message|code:\d+)$/

/** The turn's position, and which occurrence of that turn, a hit index stands for. */
interface Selection {
  turnKey: string
  ordinal: number
}

interface Ring {
  top: number
  left: number
  width: number
  height: number
}

interface OlderSearch {
  pages: number
  /** The first turn loaded when the search began; a hit above it is new. */
  boundaryKey: string | null
}

function partOf(turns: readonly Turn[], hit: FindHit): FindPart {
  return turnSegments(turns[hit.turn])[hit.segment].part
}

function scopeOf(part: FindPart): string | null {
  return part.kind === "tool" ? part.callId : null
}

/** Opens what hides `part` so its row renders it: the work fold, the group, the tool's panel. */
function revealStructure(store: TimelineStateStore, turnKey: string, turn: Turn, part: FindPart): void {
  if (part.kind === "compaction") store.open(`${turnKey}:compaction`)
  if (part.kind === "tool") {
    revealToolCall(store, turnKey, turn, part.callId)
    store.open(`${turnKey}:call:${part.callId}:panel`)
    return
  }
  if ("block" in part) openWorkFoldFor(store, turnKey, turn, part.block)
  if (part.kind === "thinking") store.set(revealKey(turnKey), part.blocks)
}

/** Opens what cuts long text short where `part` renders; returns how many opened. */
function revealLength(store: TimelineStateStore, turnKey: string, part: FindPart): number {
  if (part.kind === "tool") {
    const prefix = `${turnKey}:call:${part.callId}:`
    return store.openClosed(prefix, (key) => key !== `${prefix}input`)
  }
  return store.openClosed(`${turnKey}:`, (key) => !key.includes(":call:") && LENGTH_DISCLOSURE.test(key))
}

/** A ring over the visible part of `row`, in the coordinates of the scroller's frame. */
function ringOver(row: Element | null, scroller: HTMLElement | null): Ring | null {
  const frame = scroller?.parentElement
  if (!row || !scroller || !frame) return null
  const rect = row.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  const origin = frame.getBoundingClientRect()
  const top = Math.max(rect.top, view.top)
  const bottom = Math.min(rect.bottom, view.bottom)
  return bottom <= top ? null : { top: top - origin.top, left: rect.left - origin.left, width: rect.width, height: bottom - top }
}

/**
 * Find in the conversation. It searches the session's turns, not the DOM, so
 * matches in rows the timeline has not mounted and in collapsed content count
 * too, and the count is exact over everything loaded. It moves the timeline
 * only through `scrollToTurn`, opens what hides a match through the timeline
 * store, and paints matches with the CSS Custom Highlight API; it never
 * changes the timeline's DOM.
 */
export const FindInSession = forwardRef<FindInSessionHandle, FindInSessionProps>(
  function FindInSession({ scrollContainerRef, timelineRef, hasMore = false, isLoadingOlder = false, onLoadMore }, ref) {
    const { session } = useSessionContext()
    const store = useTimelineStore()
    const turns = session?.turns ?? NO_TURNS
    const [isOpen, setIsOpen] = useState(false)
    const [query, setQuery] = useState("")
    const [searched, setSearched] = useState("")
    const [selection, setSelection] = useState<Selection | null>(null)
    const [older, setOlder] = useState<OlderSearch | null>(null)
    const [olderExhausted, setOlderExhausted] = useState(false)
    const [ring, setRing] = useState<Ring | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const navSeq = useRef(0)

    const keys = useMemo(() => turnKeysOf(turns), [turns])
    const hits = useMemo(() => (isOpen && searched ? findInTurns(turns, searched) : NO_HITS), [isOpen, searched, turns])

    const activeIndex = useMemo(() => {
      if (!selection) return -1
      const turn = keys.indexOf(selection.turnKey)
      if (turn < 0) return -1
      const first = hits.findIndex((hit) => hit.turn === turn)
      if (first < 0) return -1
      let last = first
      while (last + 1 < hits.length && hits[last + 1].turn === turn) last++
      return Math.min(first + selection.ordinal, last)
    }, [selection, keys, hits])

    const active = useMemo<ActiveMatch | null>(() => {
      if (activeIndex < 0) return null
      const hit = hits[activeIndex]
      const callId = scopeOf(partOf(turns, hit))
      let nth = 0
      for (let i = activeIndex - 1; i >= 0 && hits[i].turn === hit.turn; i--) {
        if (scopeOf(partOf(turns, hits[i])) === callId) nth++
      }
      return { turnKey: keys[hit.turn], callId, nth }
    }, [activeIndex, hits, turns, keys])

    // ── Painting ──────────────────────────────────────────────────────────────
    const [painter] = useState(() => new FindPainter((row) => setRing(ringOver(row, scrollContainerRef.current))))
    useEffect(() => {
      painter.update(isOpen ? scrollContainerRef.current : null, searched, active)
    })
    useEffect(() => {
      const timeline = timelineRef.current
      if (!isOpen || !timeline) return
      return timeline.subscribe(painter.schedule)
    }, [isOpen, timelineRef, painter])
    useEffect(() => () => painter.dispose(), [painter])

    // ── Navigation ────────────────────────────────────────────────────────────
    const navigate = useCallback((index: number) => {
      if (hits.length === 0) return
      const i = ((index % hits.length) + hits.length) % hits.length
      const hit = hits[i]
      const turn = turns[hit.turn]
      const turnKey = keys[hit.turn]
      const part = partOf(turns, hit)
      const callId = scopeOf(part)
      let ordinal = 0
      let nth = 0
      for (let j = i - 1; j >= 0 && hits[j].turn === hit.turn; j--) {
        ordinal++
        if (scopeOf(partOf(turns, hits[j])) === callId) nth++
      }
      setSelection({ turnKey, ordinal })

      const timeline = timelineRef.current
      if (!timeline) return
      if (store) revealStructure(store, turnKey, turn, part)
      const seq = ++navSeq.current
      const q = searched
      let attempts = 0
      let lengthOpened = false
      void timeline.scrollToTurn(turnKey, {
        align: "center",
        target: (row) => {
          attempts++
          const found = activeScopeRanges(row, q, callId)
          if (!found) return null
          if (found.ranges.length > nth) return rangeElement(found.ranges[nth])
          if (!lengthOpened) {
            lengthOpened = true
            if (store && revealLength(store, turnKey, part) > 0) return null
          }
          if (attempts < SETTLE_ATTEMPTS) return null
          const closest = found.ranges.at(-1)
          return closest ? rangeElement(closest) : found.scope === row ? null : found.scope
        },
      }).then(() => {
        if (store && navSeq.current === seq) store.set(revealKey(turnKey), null)
        painter.schedule()
      })
    }, [hits, turns, keys, timelineRef, store, searched, painter])

    // A new query starts at the first match from the top of the view down.
    const navigatedFor = useRef<string | null>(null)
    useEffect(() => {
      if (!isOpen || navigatedFor.current === searched) return
      if (!searched) {
        navigatedFor.current = searched
        setSelection(null)
        return
      }
      navigatedFor.current = searched
      setOlderExhausted(false)
      if (hits.length === 0) {
        setSelection(null)
        return
      }
      const firstVisible = timelineRef.current?.getViewport().firstVisibleKey ?? null
      const from = firstVisible === null ? 0 : Math.max(0, keys.indexOf(firstVisible))
      const start = hits.findIndex((hit) => hit.turn >= from)
      navigate(start < 0 ? 0 : start)
    }, [isOpen, searched, hits, keys, navigate, timelineRef])

    // ── Older history ─────────────────────────────────────────────────────────
    useEffect(() => {
      if (!older || isLoadingOlder) return
      const boundary = older.boundaryKey === null ? 0 : keys.indexOf(older.boundaryKey)
      let newest = -1
      for (let i = 0; i < hits.length && hits[i].turn < boundary; i++) newest = i
      if (newest >= 0) {
        setOlder(null)
        navigate(newest)
        return
      }
      if (!hasMore || older.pages >= QUOTE_SEARCH_PAGES || !onLoadMore) {
        setOlder(null)
        setOlderExhausted(true)
        return
      }
      setOlder({ ...older, pages: older.pages + 1 })
      onLoadMore()
    }, [older, isLoadingOlder, hasMore, hits, keys, navigate, onLoadMore])

    const searchOlder = useCallback(() => {
      setOlderExhausted(false)
      setOlder({ pages: 0, boundaryKey: keys[0] ?? null })
    }, [keys])

    // ── Open and close ────────────────────────────────────────────────────────
    const handleClose = useCallback(() => {
      navSeq.current++
      setIsOpen(false)
      setQuery("")
      setSearched("")
      setSelection(null)
      setOlder(null)
      setOlderExhausted(false)
      navigatedFor.current = null
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        open: () => {
          setIsOpen(true)
          requestAnimationFrame(() => inputRef.current?.select())
        },
        close: handleClose,
        isOpen,
      }),
      [handleClose, isOpen]
    )

    useEffect(() => {
      const timer = setTimeout(() => setSearched(query), 150)
      return () => clearTimeout(timer)
    }, [query])

    // On the whole panel, so Escape also closes it from its buttons.
    const handlePanelKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      handleClose()
    }

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault()
        if (searched !== query) setSearched(query)
        else navigate(activeIndex + (e.shiftKey ? -1 : 1))
      }
    }

    if (!isOpen) return null

    const count = hits.length
    const status = searched
      ? count > 0 ? `${activeIndex + 1}/${count}` : "0/0"
      : ""
    const showOlder = Boolean(searched && onLoadMore && (hasMore || older))
    const navButton = cn("text-muted-foreground", count > 0 ? "hover:text-foreground" : "cursor-default opacity-40")

    return (
      <>
        {ring && (
          <div
            aria-hidden
            data-testid="find-ring"
            className="pointer-events-none absolute z-20 rounded-lg ring-2 ring-warning"
            style={ring}
          />
        )}
        <div onKeyDown={handlePanelKeyDown} className="motion-slide-down-in absolute right-4 top-12 z-30 flex flex-col gap-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-sm">
          <div className="flex items-center gap-1">
            <InputGroup className="w-64">
              <InputGroupInput
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Find in conversation"
                aria-label="Find in conversation"
                autoFocus
              />
              <InputGroupAddon align="inline-end">
                <span className="min-w-12 text-center text-xs tabular-nums" aria-live="polite">{status}</span>
              </InputGroupAddon>
            </InputGroup>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => navigate(activeIndex - 1)} disabled={count === 0} className={navButton} aria-label="Previous match">
              <ChevronUp data-icon="inline-start" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => navigate(activeIndex + 1)} disabled={count === 0} className={navButton} aria-label="Next match">
              <ChevronDown data-icon="inline-start" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleClose} className="text-muted-foreground hover:text-foreground" aria-label="Close search">
              <X data-icon="inline-start" />
            </Button>
          </div>
          {showOlder && (
            <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
              {older ? (
                <span className="flex items-center gap-1.5" role="status">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Searching older history… {older.pages}/{QUOTE_SEARCH_PAGES} pages
                </span>
              ) : (
                <span>{olderExhausted ? (hasMore ? `No match in ${QUOTE_SEARCH_PAGES} more pages` : "No match in older history") : "Older history is not loaded"}</span>
              )}
              {older ? (
                <Button type="button" variant="ghost" size="xs" onClick={() => setOlder(null)}>Stop</Button>
              ) : hasMore && (
                <Button type="button" variant="ghost" size="xs" onClick={searchOlder}>
                  <History data-icon="inline-start" />
                  Search older history
                </Button>
              )}
            </div>
          )}
        </div>
      </>
    )
  }
)
