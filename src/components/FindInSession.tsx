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
import { openWorkFoldFor, revealKey, revealToolCall, useTimelineStore, type RevealTarget, type TimelineStateStore } from "@/components/timeline/disclosure"
import { findInTurns, firstGroupOfTurn, groupOfHit, NO_RESULTS, turnSegments, type FindPart, type FindResults } from "@/lib/sessionFind"
import { FindPainter, pickSpan, scopeSpans, spanElement, type ActiveMatch } from "@/lib/sessionFindDom"
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
/** Landing attempts that may wait for revealed content before settling for the closest occurrence. */
const SETTLE_ATTEMPTS = 4
/** Disclosures inside a tool card that only cut long content short. */
const TOOL_LENGTH = /^(result|details|text:[^:]+|cmd:\d+:open|all:result)$/
/** Disclosures elsewhere in a turn that only cut long text short. */
const TEXT_LENGTH = /(^|:)(user:more|message)$/

/** The turn, and which of its occurrences, the selected match is. Survives prepends and live updates. */
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

interface Hit {
  turn: Turn
  turnKey: string
  part: FindPart
  /** Index among the turn's own hits. */
  ordinal: number
  active: ActiveMatch
}

function isResult(part: FindPart): boolean {
  return part.kind === "tool" && part.result
}

/**
 * What hit `index` is: its turn and part, and which DOM occurrence stands for
 * it. A tool card counts its own occurrences; a result renders last in the
 * card, so its hits count from the card's end, past the header and inputs
 * that repeat what the model indexed once.
 */
function describeHit(results: FindResults, turns: readonly Turn[], keys: readonly string[], index: number): Hit {
  const g = groupOfHit(results, index)
  const group = results.groups[g]
  const turn = turns[group.turn]
  const segments = turnSegments(turn)
  const part = segments[group.segment].part
  const first = firstGroupOfTurn(results, group.turn)
  const within = index - results.starts[g]
  const callId = part.kind === "tool" ? part.callId : null
  const sameScope = (other: FindPart) => (other.kind === "tool" ? other.callId : null) === callId && isResult(other) === isResult(part)
  const fromEnd = isResult(part)
  let nth = fromEnd ? group.count - 1 - within : within
  if (fromEnd) {
    for (let h = g + 1; h < results.groups.length && results.groups[h].turn === group.turn; h++) {
      if (sameScope(segments[results.groups[h].segment].part)) nth += results.groups[h].count
    }
  } else {
    for (let h = g - 1; h >= first; h--) {
      if (sameScope(segments[results.groups[h].segment].part)) nth += results.groups[h].count
    }
  }
  const turnKey = keys[group.turn]
  return { turn, turnKey, part, ordinal: index - results.starts[first], active: { turnKey, callId, nth, fromEnd } }
}

/** The hit a selection stands for now, or -1 when its turn has none. */
function indexOfSelection(results: FindResults, keys: readonly string[], selection: Selection | null): number {
  if (!selection) return -1
  const turn = keys.indexOf(selection.turnKey)
  const first = turn < 0 ? -1 : firstGroupOfTurn(results, turn)
  if (first < 0) return -1
  let last = first
  while (last + 1 < results.groups.length && results.groups[last + 1].turn === turn) last++
  const turnEnd = results.starts[last] + results.groups[last].count
  return Math.min(results.starts[first] + selection.ordinal, turnEnd - 1)
}

/** Opens what hides `part` so its row renders it; returns the reveal request it made, if any. */
function revealStructure(store: TimelineStateStore, turnKey: string, turn: Turn, part: FindPart): RevealTarget | null {
  if (part.kind === "compaction") store.open(`${turnKey}:compaction`)
  if (part.kind === "tool") {
    revealToolCall(store, turnKey, turn, part.callId)
    store.open(`${turnKey}:call:${part.callId}:panel`)
    return part.callId
  }
  if ("block" in part) openWorkFoldFor(store, turnKey, turn, part.block)
  if (part.kind !== "thinking") return null
  store.set(revealKey(turnKey), part.blocks)
  return part.blocks
}

/** Opens what cuts long content short where `part` renders; returns how many opened. */
function revealLength(store: TimelineStateStore, turnKey: string, part: FindPart): number {
  if (part.kind === "tool") {
    const prefix = `${turnKey}:call:${part.callId}:`
    return store.openClosed(prefix, (key) => TOOL_LENGTH.test(key.slice(prefix.length)))
  }
  return store.openClosed(`${turnKey}:`, (key) => !key.includes(":call:") && TEXT_LENGTH.test(key))
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
 * changes the timeline's DOM. Mount one per session.
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
    const results = useMemo(() => (isOpen && searched ? findInTurns(turns, searched) : NO_RESULTS), [isOpen, searched, turns])
    const total = results.total
    const activeIndex = useMemo(() => indexOfSelection(results, keys, selection), [results, keys, selection])
    const active = useMemo(
      () => (activeIndex < 0 ? null : describeHit(results, turns, keys, activeIndex).active),
      [activeIndex, results, turns, keys],
    )

    // ── Painting ──────────────────────────────────────────────────────────────
    const [painter] = useState(() => new FindPainter((row) => setRing(ringOver(row, scrollContainerRef.current))))
    useEffect(() => {
      painter.update(isOpen ? scrollContainerRef.current : null, searched, active)
    })
    useEffect(() => {
      const timeline = timelineRef.current
      if (!isOpen || !timeline) return
      return timeline.subscribe(painter.scheduleRing)
    }, [isOpen, timelineRef, painter])
    useEffect(() => () => painter.dispose(), [painter])

    // ── Navigation ────────────────────────────────────────────────────────────
    const navigate = useCallback((index: number) => {
      if (total === 0) return
      const hit = describeHit(results, turns, keys, ((index % total) + total) % total)
      const { turnKey, part } = hit
      const { callId, nth, fromEnd } = hit.active
      setSelection({ turnKey, ordinal: hit.ordinal })

      const timeline = timelineRef.current
      if (!timeline) return
      const revealed = store ? revealStructure(store, turnKey, hit.turn, part) : null
      const seq = ++navSeq.current
      const q = searched
      let attempts = 0
      let lengthOpened = false
      void timeline.scrollToTurn(turnKey, {
        align: "center",
        target: (row) => {
          // The first try runs before React has rendered what the reveal opened.
          if (++attempts === 1) return null
          const found = scopeSpans(row, q, callId)
          if (!found) return null
          if (found.spans.length > nth) return spanElement(pickSpan(found.spans, nth, fromEnd)!)
          if (!lengthOpened) {
            lengthOpened = true
            if (store && revealLength(store, turnKey, part) > 0) return null
          }
          if (attempts < SETTLE_ATTEMPTS) return null
          const closest = pickSpan(found.spans, nth, fromEnd)
          return closest ? spanElement(closest) : found.scope === row ? null : found.scope
        },
      }).then(() => {
        if (store && revealed !== null && store.get(revealKey(turnKey)) === revealed) store.set(revealKey(turnKey), null)
        if (navSeq.current === seq) painter.schedule()
      })
    }, [results, total, turns, keys, timelineRef, store, searched, painter])

    const step = (direction: 1 | -1) => navigate(activeIndex < 0 ? (direction > 0 ? 0 : -1) : activeIndex + direction)

    // A new query starts at the first match from the top of the view down,
    // or at the first match that turns up later (a live reply, a page loaded).
    const navigatedFor = useRef<string | null>(null)
    useEffect(() => {
      if (!isOpen || navigatedFor.current === searched || older) return
      if (!searched || total === 0) {
        setSelection(null)
        return
      }
      navigatedFor.current = searched
      const firstVisible = timelineRef.current?.getViewport().firstVisibleKey ?? null
      const from = firstVisible === null ? 0 : Math.max(0, keys.indexOf(firstVisible))
      const group = results.groups.findIndex((g) => g.turn >= from)
      navigate(group < 0 ? 0 : results.starts[group])
    }, [isOpen, searched, older, results, total, keys, navigate, timelineRef])

    useEffect(() => setOlderExhausted(false), [searched])

    // ── Older history ─────────────────────────────────────────────────────────
    useEffect(() => {
      if (!older || isLoadingOlder) return
      const boundary = older.boundaryKey === null ? 0 : keys.indexOf(older.boundaryKey)
      if (boundary < 0) {
        setOlder(null)
        return
      }
      let above = -1
      for (let g = 0; g < results.groups.length && results.groups[g].turn < boundary; g++) above = g
      if (above >= 0) {
        setOlder(null)
        navigatedFor.current = searched
        navigate(results.starts[above] + results.groups[above].count - 1)
        return
      }
      if (!hasMore || older.pages >= QUOTE_SEARCH_PAGES || !onLoadMore) {
        setOlder(null)
        setOlderExhausted(true)
        return
      }
      setOlder({ ...older, pages: older.pages + 1 })
      onLoadMore()
    }, [older, isLoadingOlder, hasMore, results, keys, navigate, onLoadMore, searched])

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
        else step(e.shiftKey ? -1 : 1)
      }
    }

    if (!isOpen) return null

    const count = total
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
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={count === 0} className={navButton} aria-label="Previous match">
              <ChevronUp data-icon="inline-start" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(1)} disabled={count === 0} className={navButton} aria-label="Next match">
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
