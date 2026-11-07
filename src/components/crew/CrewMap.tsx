import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Bot, Maximize2, Minus, Network, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import type { AgentKind } from "@/lib/agents"
import { agentIcon } from "@/lib/agents/presentation"
import { deviceScopedKey } from "@/lib/device"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CrewMember, SessionCrew } from "../../../shared/contracts/crew"
import { shortenModel } from "../../../shared/session/model-names"
import {
  acrossWidth,
  CARD_HEIGHT,
  CARD_WIDTH,
  COLUMN_GAP,
  crewDepth,
  crewMapCounts,
  FOLD_ROOM,
  INDENT,
  layoutCrewMap,
  trailTo,
  type CrewMapFilter,
  type CrewMapLayout,
  type CrewMapNode,
} from "./crewMapLayout"
import { CREW_DOT, hasUnreadResult, memberActivity, memberCellState, startedLabel, type CrewCellState } from "./crewView"

const PAD = 14
const MIN_SCALE = 0.25
const MAX_SCALE = 1.5
/** The smallest scale the map opens at; smaller is for the user to choose. */
const OPEN_SCALE = 0.7
const ZOOM_STEP = 1.2
const CONTROLS_CLEARANCE = 56
/** The narrowest view that gets grids, below which a column scrolls better. */
const GROUP_VIEW_WIDTH = 900
/** The panel draws the crew across only when all of it fits at this scale or larger; otherwise it stacks. */
const ACROSS_MIN_SCALE = 0.85
const STACKED_CARD_MAX = 320
/** Maps with more cards than this draw only those near the view. */
export const MAP_WINDOW_MIN = 150

export interface CrewMapViewport {
  frame: Frame
  left: number
  top: number
}

type Folds = Record<CrewMapFilter, ReadonlySet<string>>

export interface CrewMapControls {
  filter: CrewMapFilter
  setFilter: (filter: CrewMapFilter) => void
  /** Branches the user folded under the current filter. */
  collapsed: ReadonlySet<string>
  toggle: (sessionId: string) => void
  /** Where the panel's map was left, so coming back to the tab finds it there. */
  viewport: { current: CrewMapViewport | null }
}

const NO_FOLDS: Folds = { all: new Set(), active: new Set() }

/**
 * The map's filter, remembered on this device, and its folds and viewport,
 * which belong to one crew: moving between its sessions keeps them, another
 * crew starts fresh.
 */
export function useCrewMapControls(rootId: string): CrewMapControls {
  const [stored, setFilter] = useLocalStorage<CrewMapFilter>(deviceScopedKey("crew-map-filter"), "all")
  const filter: CrewMapFilter = stored === "active" ? "active" : "all"
  const [folds, setFolds] = useState<{ rootId: string; folds: Folds }>({ rootId, folds: NO_FOLDS })
  const viewports = useRef(new Map<string, CrewMapViewport | null>())
  const current = folds.rootId === rootId ? folds.folds : NO_FOLDS
  const toggle = useCallback((sessionId: string) => setFolds((previous) => {
    const base = previous.rootId === rootId ? previous.folds : NO_FOLDS
    const next = new Set(base[filter])
    if (!next.delete(sessionId)) next.add(sessionId)
    return { rootId, folds: { ...base, [filter]: next } }
  }), [filter, rootId])
  const viewport = useMemo(() => ({
    get current() { return viewports.current.get(rootId) ?? null },
    set current(value: CrewMapViewport | null) { viewports.current.set(rootId, value) },
  }), [rootId])
  return { filter, setFilter, collapsed: current[filter], toggle, viewport }
}

interface CrewMapProps {
  crew: SessionCrew
  hereId: string | null
  controls: CrewMapControls
  kinds: ReadonlyMap<string, AgentKind>
  nameOf: (member: CrewMember) => string
  onOpen: (member: CrewMember) => void
}

/**
 * The crew drawn as a tree of cards from its root, with a filter for what is
 * working or waiting on the user, folds for busy branches, and a larger view
 * when the panel is too narrow for it.
 */
export function CrewMap({ crew, hereId, controls, kinds, nameOf, onOpen }: CrewMapProps) {
  const [expanded, setExpanded] = useState(false)
  const { filter, collapsed, toggle } = controls
  const root = crew.members.find((member) => member.sessionId === crew.rootId)
  const canvas = (memory: CrewMapControls["viewport"] | null, open: (member: CrewMember) => void) => (
    <CrewMapCanvas
      crew={crew}
      collapsed={collapsed}
      groups={!memory}
      filter={filter}
      hereId={hereId}
      kinds={kinds}
      nameOf={nameOf}
      memory={memory}
      onOpen={open}
      onToggle={toggle}
      onShowAll={() => controls.setFilter("all")}
    />
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <FilterToggle crew={crew} controls={controls} />
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" aria-label="Expand the map" title="Expand the map" onClick={() => setExpanded(true)}>
          <Maximize2 data-icon="inline-start" />
        </Button>
      </div>
      {canvas(controls.viewport, onOpen)}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton
          className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-4rem)] sm:w-[calc(100vw-4rem)] sm:max-w-none"
        >
          <DialogTitle className="sr-only">Crew map</DialogTitle>
          <DialogDescription className="sr-only">Every session in this crew, from the one that started it.</DialogDescription>
          <header className="flex h-12 shrink-0 items-center gap-3 pl-4 pr-14">
            <Network aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium">{root ? nameOf(root) : "Crew"}</span>
            <span className="flex-1" />
            <FilterToggle crew={crew} controls={controls} />
          </header>
          {canvas(null, (member) => {
            setExpanded(false)
            onOpen(member)
          })}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FilterToggle({ crew, controls }: { crew: SessionCrew; controls: CrewMapControls }) {
  const counts = crewMapCounts(crew)
  const options: Array<{ id: CrewMapFilter; label: string; count: number; hint: string }> = [
    { id: "all", label: "All", count: counts.all, hint: "Every session in the crew" },
    { id: "active", label: "Active", count: counts.active, hint: "Sessions working or waiting on you, and the sessions that started them" },
  ]
  return (
    <div role="radiogroup" aria-label="Show on the map" className="flex shrink-0 gap-0.5 rounded-full border bg-background p-0.5">
      {options.map(({ id, label, count, hint }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={controls.filter === id}
          aria-label={`${label}, ${sessionCount(count)}`}
          title={hint}
          onClick={() => controls.setFilter(id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            controls.filter === id && "bg-accent text-foreground",
          )}
        >
          {label}
          <span className="tabular-nums text-muted-foreground">{count}</span>
        </button>
      ))}
    </div>
  )
}

function sessionCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

interface Size { width: number; height: number }

/** Before the map's area is measured, which happens before it is first painted. */
const UNMEASURED: Size = { width: 0, height: 0 }

/** How the map is drawn: its zoom, and where its top-left corner sits in the scrolled area. */
interface Frame {
  scale: number
  left: number
  top: number
}

/**
 * A frame centring an across crew and keeping it near the top, as a page
 * reads. It is worked out when the map is placed or zoomed and then kept, so
 * folding a branch or a member finishing never slides the map sideways.
 */
function frameFor(layout: CrewMapLayout, scale: number, size: Size): Frame {
  // A stacked crew reads like a list, from the top left.
  if (layout.orientation === "stacked") return { scale, left: PAD, top: PAD }
  return {
    scale,
    left: Math.max(PAD, (size.width - layout.width * scale) / 2),
    top: Math.max(PAD, Math.min((size.height - layout.height * scale) / 2, size.height * 0.12)),
  }
}

/** The scrolled area: the viewport at least, and room under the last card to scroll it clear of the zoom controls. */
function areaFor(layout: CrewMapLayout, frame: Frame, size: Size): Size {
  return {
    width: Math.max(size.width, frame.left + layout.width * frame.scale + PAD),
    height: Math.max(size.height, frame.top + layout.height * frame.scale + CONTROLS_CLEARANCE),
  }
}

function fitScale(layout: CrewMapLayout, size: Size, { widthOnly = false } = {}): number {
  if (layout.width === 0 || size.width === 0) return 1
  const across = (size.width - 2 * PAD) / layout.width
  const scale = widthOnly ? across : Math.min(across, (size.height - 2 * PAD) / layout.height)
  return clamp(scale, MIN_SCALE, 1)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** A box in the map's own coordinates. */
interface Region { left: number; top: number; right: number; bottom: number }

/** The part of the map on screen, in its own coordinates. */
function viewRegion(element: HTMLElement, frame: Frame): Region {
  const left = (element.scrollLeft - frame.left) / frame.scale
  const top = (element.scrollTop - frame.top) / frame.scale
  return { left, top, right: left + element.clientWidth / frame.scale, bottom: top + element.clientHeight / frame.scale }
}

const contains = (outer: Region, inner: Region) =>
  inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom

/** A region a screen larger on every side, so ordinary scrolling stays inside what is drawn. */
function drawnAround(view: Region): Region {
  const width = view.right - view.left
  const height = view.bottom - view.top
  return { left: view.left - width, top: view.top - height, right: view.right + width, bottom: view.bottom + height }
}

/** Where to scroll along one axis so the span from `start` to `end` is in view, moving as little as possible. */
function nearest(scroll: number, view: number, start: number, end: number): number {
  if (start < scroll) return start
  if (end > scroll + view) return Math.min(start, end - view)
  return scroll
}

interface Scroll { left: number; top: number }

/** Where the viewport should scroll once the map is drawn in `frame`. */
interface PendingScroll {
  frame: Frame
  scroll: () => Scroll
}

interface Shown {
  layout: CrewMapLayout
  filter: CrewMapFilter
  frame: Frame
}

/**
 * Where to scroll after the crew changed shape so the card the user just
 * folded, or the first one they could see, stays where it was on screen;
 * null when nothing moved or nothing on screen is still drawn.
 */
function anchoredScroll(scrolled: Scroll, before: Shown, after: CrewMapLayout, frame: Frame, anchorId: string | null): Scroll | null {
  const previous = new Map(before.layout.nodes.map((node) => [node.member.sessionId, node]))
  const next = new Map(after.nodes.map((node) => [node.member.sessionId, node]))
  const unmoved = before.frame === frame && previous.size === next.size && after.nodes.every((node) => {
    const was = previous.get(node.member.sessionId)
    return was !== undefined && was.x === node.x && was.y === node.y
  })
  if (unmoved) return null
  const toScreen = (node: CrewMapNode) => ({
    x: before.frame.left + node.x * before.frame.scale - scrolled.left,
    y: before.frame.top + node.y * before.frame.scale - scrolled.top,
  })
  const chosen = anchorId && previous.has(anchorId) && next.has(anchorId)
    ? anchorId
    : before.layout.nodes
      .filter((node) => next.has(node.member.sessionId))
      .map((node) => ({ node, screen: toScreen(node) }))
      .filter(({ screen }) => screen.y + CARD_HEIGHT * before.frame.scale > 0 && screen.x + before.layout.cardWidth * before.frame.scale > 0)
      .sort((a, b) => a.screen.y - b.screen.y || a.screen.x - b.screen.x)[0]?.node.member.sessionId
  if (!chosen) return null
  const screen = toScreen(previous.get(chosen)!)
  const target = next.get(chosen)!
  return { left: frame.left + target.x * frame.scale - screen.x, top: frame.top + target.y * frame.scale - screen.y }
}

/**
 * Where to scroll so the open session is in view, with the session that
 * started it when both fit; the top left when it is already in view.
 */
function revealScroll(layout: CrewMapLayout, hereId: string | null, frame: Frame, element: HTMLElement): Scroll {
  const nodes = new Map(layout.nodes.map((node) => [node.member.sessionId, node]))
  const node = hereId ? nodes.get(hereId) : undefined
  if (!node) return { left: 0, top: 0 }
  const { scale } = frame
  const left = frame.left + node.x * scale
  const top = frame.top + node.y * scale
  const right = left + layout.cardWidth * scale
  const bottom = top + CARD_HEIGHT * scale
  if (right <= element.clientWidth && bottom <= element.clientHeight) return { left: 0, top: 0 }
  const from = (node.member.parentId && nodes.get(node.member.parentId)) || node
  let scrollLeft = frame.left + Math.min(from.x, node.x) * scale - PAD
  let scrollTop = frame.top + Math.min(from.y, node.y) * scale - PAD
  if (right - scrollLeft > element.clientWidth) scrollLeft = left - PAD
  if (bottom - scrollTop > element.clientHeight) scrollTop = top - element.clientHeight / 3
  return { left: Math.max(0, scrollLeft), top: Math.max(0, scrollTop) }
}

interface CanvasProps {
  crew: SessionCrew
  collapsed: ReadonlySet<string>
  /** Gather many childless siblings into a grid once the view is wide enough for one. */
  groups: boolean
  filter: CrewMapFilter
  hereId: string | null
  kinds: ReadonlyMap<string, AgentKind>
  nameOf: (member: CrewMember) => string
  /** Where to keep the viewport between visits; null starts fitted every time. */
  memory: CrewMapControls["viewport"] | null
  onOpen: (member: CrewMember) => void
  onToggle: (sessionId: string) => void
  onShowAll: () => void
}

function CrewMapCanvas({ crew, collapsed, groups, filter, hereId, kinds, nameOf, memory, onOpen, onToggle, onShowAll }: CanvasProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>(UNMEASURED)
  const group = groups && size.width >= GROUP_VIEW_WIDTH
  // The panel stacks a crew too deep to read across it; how deep is the whole crew's, so a filter or fold never flips it.
  const depth = useMemo(() => crewDepth(crew), [crew])
  const room = size.width - 2 * PAD
  const stacked = !groups && size.width > 0 && acrossWidth(depth) * ACROSS_MIN_SCALE > room
  const cardWidth = stacked ? clamp(room - depth * INDENT - FOLD_ROOM, CARD_WIDTH, STACKED_CARD_MAX) : CARD_WIDTH
  const layout = useMemo(
    () => layoutCrewMap(crew, filter, collapsed, { group, ...(stacked && { stacked: { cardWidth } }) }),
    [crew, filter, collapsed, group, stacked, cardWidth],
  )
  const [frame, setFrame] = useState<Frame>(() => memory?.current?.frame ?? { scale: 1, left: PAD, top: PAD })
  const [dragging, setDragging] = useState(false)
  const pending = useRef<PendingScroll | null>(null)
  const anchor = useRef<string | null>(null)
  // The scroll position as last seen; when the crew shrinks, the browser clamps the live one before the map can re-anchor.
  const scrolled = useRef<Scroll>({ left: 0, top: 0 })
  const shown = useRef<Shown | null>(null)
  const [drawn, setDrawn] = useState<Region | null>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const area = areaFor(layout, frame, size)
  const { scale } = frame

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setSize((current) => (
      current !== UNMEASURED && current.width === element.clientWidth && current.height === element.clientHeight
        ? current
        : { width: element.clientWidth, height: element.clientHeight }
    ))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const remember = useCallback((at: Frame) => {
    const element = scroller.current
    if (memory && element) memory.current = { frame: at, left: element.scrollLeft, top: element.scrollTop }
  }, [memory])

  const drawThenScroll = useCallback((next: Frame, scroll: () => Scroll) => {
    pending.current = { frame: next, scroll }
    setFrame(next)
  }, [])

  /** Fit what is shown across, no smaller than readable, with the open session in view; a long crew scrolls down. */
  const settle = useCallback((target: CrewMapLayout) => {
    const next = frameFor(target, Math.max(fitScale(target, size, { widthOnly: true }), OPEN_SCALE), size)
    drawThenScroll(next, () => {
      const element = scroller.current
      return element ? revealScroll(target, hereId, next, element) : { left: 0, top: 0 }
    })
  }, [drawThenScroll, hereId, size])

  // First sight, a filter switch, and a changed crew shape each place the map.
  useLayoutEffect(() => {
    const element = scroller.current
    if (size.width === 0 || !element) return
    const before = shown.current
    if (!before) {
      const saved = memory?.current
      if (saved) drawThenScroll(saved.frame, () => ({ left: saved.left, top: saved.top }))
      else settle(layout)
    } else if (before.filter !== filter || before.layout.orientation !== layout.orientation) {
      settle(layout)
    } else if (before.layout !== layout) {
      const scroll = anchoredScroll(scrolled.current, before, layout, frame, anchor.current)
      if (scroll) {
        element.scrollLeft = scroll.left
        element.scrollTop = scroll.top
        scrolled.current = { left: element.scrollLeft, top: element.scrollTop }
      }
    }
    anchor.current = null
    shown.current = { layout, filter, frame }
  })

  useLayoutEffect(() => {
    const target = pending.current
    const element = scroller.current
    if (!target || !element || target.frame !== frame) return
    pending.current = null
    const { left, top } = target.scroll()
    element.scrollLeft = left
    element.scrollTop = top
    scrolled.current = { left: element.scrollLeft, top: element.scrollTop }
    remember(frame)
  })

  // Moving to another session of the crew brings its card into view, without re-placing the map.
  const lastHere = useRef(hereId)
  useEffect(() => {
    if (lastHere.current === hereId) return
    lastHere.current = hereId
    const element = scroller.current
    const node = hereId ? layout.nodes.find((value) => value.member.sessionId === hereId) : undefined
    if (!element || !node) return
    const left = frame.left + node.x * frame.scale
    const top = frame.top + node.y * frame.scale
    element.scrollTo?.({
      left: nearest(element.scrollLeft, element.clientWidth, left, left + layout.cardWidth * frame.scale),
      top: nearest(element.scrollTop, element.clientHeight, top, top + CARD_HEIGHT * frame.scale),
      behavior: "smooth",
    })
  }, [frame, hereId, layout])

  // A large map draws only the cards near the view, and draws more once scrolling nears the edge of what it drew.
  const large = layout.nodes.length > MAP_WINDOW_MIN
  // An area that measures empty (a test DOM) cannot be windowed, so it draws every card.
  const windowed = large && size.width > 0 && size.height > 0
  const followView = useCallback(() => {
    const element = scroller.current
    if (!element || !windowed) return
    const view = viewRegion(element, frame)
    setDrawn((current) => (current && contains(current, view) ? current : drawnAround(view)))
  }, [frame, windowed])
  useLayoutEffect(() => { followView() }, [followView, layout])
  const nodes = useMemo(() => {
    if (large && (size === UNMEASURED || (windowed && !drawn))) return []
    if (!windowed || !drawn) return layout.nodes
    return layout.nodes.filter((node) => node.x + layout.cardWidth >= drawn.left && node.x <= drawn.right
      && node.y + CARD_HEIGHT >= drawn.top && node.y <= drawn.bottom)
  }, [drawn, large, layout, size, windowed])

  /** Zoom by a factor around a point on screen, the viewport's centre by default. */
  const zoomBy = useCallback((factor: number, focus?: { clientX: number; clientY: number }) => {
    const element = scroller.current
    // Wheel events can outrun rendering; each builds on the zoom still waiting to be drawn.
    const base = pending.current?.frame.scale ?? scale
    const target = clamp(base * factor, MIN_SCALE, MAX_SCALE)
    if (!element || target === base) return
    const rect = element.getBoundingClientRect()
    const screenX = focus ? focus.clientX - rect.left : element.clientWidth / 2
    const screenY = focus ? focus.clientY - rect.top : element.clientHeight / 2
    const contentX = (element.scrollLeft + screenX - frame.left) / scale
    const contentY = (element.scrollTop + screenY - frame.top) / scale
    const next = frameFor(layout, target, size)
    drawThenScroll(next, () => ({
      left: next.left + contentX * next.scale - screenX,
      top: next.top + contentY * next.scale - screenY,
    }))
  }, [drawThenScroll, frame.left, frame.top, layout, scale, size])

  // Pinch on a trackpad, or Ctrl/⌘ with the wheel, zooms around the pointer; plain scrolling pans.
  const zoomRef = useRef(zoomBy)
  useLayoutEffect(() => { zoomRef.current = zoomBy })
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomRef.current(Math.exp(-event.deltaY * 0.01), event)
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scroller.current
    if (!element || event.pointerType !== "mouse" || event.button !== 0) return
    if ((event.target as Element).closest("button")) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    element.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    const element = scroller.current
    if (!start || !element || start.pointerId !== event.pointerId) return
    element.scrollLeft = start.left - (event.clientX - start.x)
    element.scrollTop = start.top - (event.clientY - start.y)
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    scroller.current?.releasePointerCapture(event.pointerId)
    setDragging(false)
  }

  const toggleAnchored = useCallback((sessionId: string) => {
    anchor.current = sessionId
    onToggle(sessionId)
  }, [onToggle])
  const trail = useMemo(() => trailTo(layout, hereId), [layout, hereId])
  const empty = layout.nodes.length === 0
  // Across, the fold toggle sits where the connector leaves the card; stacked, beside it.
  const toggleLeft = layout.orientation === "stacked" ? layout.cardWidth + FOLD_ROOM / 2 : CARD_WIDTH + COLUMN_GAP / 2

  return (
    <div className="relative min-h-0 flex-1 border-t">
      <div
        ref={scroller}
        role="region"
        aria-label="Crew map"
        data-crew-map-layout={layout.orientation}
        onScroll={(event) => {
          scrolled.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
          if (!pending.current) remember(frame)
          followView()
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP)
          else if (event.key === "-") zoomBy(1 / ZOOM_STEP)
        }}
        tabIndex={-1}
        className={cn(
          "absolute inset-0 overflow-auto overscroll-contain outline-none [touch-action:pan-x_pan-y]",
          "bg-muted/30 bg-local bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-size-[18px_18px]",
          dragging ? "cursor-grabbing select-none" : "cursor-grab",
        )}
      >
        {empty ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>Nothing is active</EmptyTitle>
              <EmptyDescription className="text-xs">No session in this crew is working or waiting on you.</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="xs" onClick={onShowAll}>Show all sessions</Button>
          </Empty>
        ) : (
          <div className="relative" style={{ width: area.width, height: area.height }}>
            <div
              className="absolute origin-top-left"
              style={{ left: frame.left, top: frame.top, width: layout.width, height: layout.height, transform: `scale(${scale})` }}
            >
              {layout.groups.map((grid) => (
                <div
                  key={grid.parentId}
                  aria-hidden="true"
                  className="absolute rounded-xl border border-dashed border-muted-foreground/25 bg-muted/25"
                  style={{ left: grid.x, top: grid.y, width: grid.width, height: grid.height }}
                />
              ))}
              <svg aria-hidden="true" width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0 overflow-visible" fill="none">
                {layout.edges.map((edge) => (
                  <path key={edge.parentId} d={edge.path} className="stroke-muted-foreground/35" strokeWidth={1.25} />
                ))}
                {trail && <path d={trail} className="stroke-foreground/55" strokeWidth={1.5} />}
              </svg>
              <ul aria-label="Sessions" className="absolute inset-0">
                {nodes.map((node) => (
                  <CrewMapItem
                    key={node.member.sessionId}
                    node={node}
                    width={layout.cardWidth}
                    toggleLeft={toggleLeft}
                    here={node.member.sessionId === hereId}
                    kind={kinds.get(node.member.sessionId)}
                    name={nameOf(node.member)}
                    onOpen={onOpen}
                    onToggle={toggleAnchored}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
      {!empty && (
        <div className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm">
          <Button variant="ghost" size="icon-xs" aria-label="Zoom out" title="Zoom out" disabled={scale <= MIN_SCALE} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Minus data-icon="inline-start" />
          </Button>
          <Button variant="ghost" size="xs" aria-label="Actual size" title="Actual size" className="min-w-11 px-1 tabular-nums text-muted-foreground" onClick={() => zoomBy(1 / scale)}>
            {Math.round(scale * 100)}%
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Zoom in" title="Zoom in" disabled={scale >= MAX_SCALE} onClick={() => zoomBy(ZOOM_STEP)}>
            <Plus data-icon="inline-start" />
          </Button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="xs"
            title="Fit the whole crew on screen"
            className="px-1.5 text-muted-foreground"
            onClick={() => drawThenScroll(frameFor(layout, fitScale(layout, size), size), () => ({ left: 0, top: 0 }))}
          >
            Fit
          </Button>
        </div>
      )}
    </div>
  )
}

const CARD_TONE: Partial<Record<CrewCellState, string>> = {
  "needs-you": "border-warning/60 bg-[color-mix(in_oklch,var(--warning)_7%,var(--card))]",
  failed: "border-destructive/45",
  unreachable: "border-dashed",
}

const ACTIVITY_TONE: Partial<Record<CrewCellState, string>> = {
  "needs-you": "text-warning",
  failed: "text-destructive",
}

/** Model, machine, pull request and last activity: whichever the member has. */
function cardMeta(member: CrewMember): string {
  const pullRequest = member.pullRequests?.at(-1)
  return [
    member.model && shortenModel(member.model),
    member.device?.name,
    pullRequest && `#${pullRequest.number}`,
    member.lastActivityAt && formatRelativeTime(member.lastActivityAt),
  ].filter(Boolean).join(" · ")
}

const CrewMapItem = memo(function CrewMapItem({
  node,
  width,
  toggleLeft,
  here,
  kind,
  name,
  onOpen,
  onToggle,
}: {
  node: CrewMapNode
  width: number
  toggleLeft: number
  here: boolean
  kind: AgentKind | undefined
  name: string
  onOpen: (member: CrewMember) => void
  onToggle: (sessionId: string) => void
}) {
  const { member } = node
  const state = memberCellState(member)
  const activity = memberActivity(member)
  const Icon = kind ? agentIcon(kind) : Bot
  const meta = cardMeta(member)
  const label = [name, activity, node.context && "shown because a session it started is active"].filter(Boolean).join(", ")
  return (
    <li
      className="group/node absolute"
      style={{ left: node.x, top: node.y, width, height: CARD_HEIGHT }}
    >
      <Tooltip>
        <TooltipTrigger
          delay={700}
          render={
            <button
              type="button"
              data-crew-map-card={member.sessionId}
              data-crew-map-state={state}
              aria-current={here ? "true" : undefined}
              aria-label={label}
              onClick={() => onOpen(member)}
              className={cn(
                "flex size-full cursor-pointer flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs outline-none",
                "transition-[border-color,opacity,box-shadow] hover:border-foreground/25 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring",
                CARD_TONE[state],
                here && "outline-solid outline-[1.5px] outline-offset-2 outline-foreground/70",
                node.context && "opacity-60 hover:opacity-100 focus-visible:opacity-100",
              )}
            />
          }
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <Icon aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
            <span className="line-clamp-2 min-w-0 flex-1 text-[13px]/[18px] font-medium">{name}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className={cn("size-1.5 shrink-0 rounded-full", CREW_DOT[state])} aria-hidden="true" />
            <span className={cn("min-w-0 truncate text-muted-foreground", hasUnreadResult(member) ? "text-warning" : ACTIVITY_TONE[state])}>
              {activity}
            </span>
          </span>
          {(meta || here) && (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-muted-foreground/75">
              <span className="min-w-0 flex-1 truncate">{meta}</span>
              {here && <span className="shrink-0 font-medium text-foreground/70">You are here</span>}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="left" align="start" className="max-w-72">
          <MemberDetails member={member} name={name} />
        </TooltipContent>
      </Tooltip>
      {node.childCount > 0 && <FoldToggle node={node} name={name} left={toggleLeft} onToggle={onToggle} />}
    </li>
  )
})

function FoldToggle({ node, name, left, onToggle }: { node: CrewMapNode; name: string; left: number; onToggle: (sessionId: string) => void }) {
  const { collapsed, hidden } = node
  let busy: "needs-you" | "working" | null = null
  if (hidden.needsYou > 0) busy = "needs-you"
  else if (hidden.working > 0) busy = "working"
  const label = collapsed
    ? [
      `Show the ${sessionCount(hidden.count)} under ${name}`,
      hidden.needsYou > 0 && `${hidden.needsYou} waiting on you`,
      hidden.working > 0 && `${hidden.working} working`,
    ].filter(Boolean).join(", ")
    : `Fold the sessions under ${name}`
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={label}
      title={collapsed ? undefined : "Fold"}
      onClick={() => onToggle(node.member.sessionId)}
      className={cn(
        "absolute z-10 flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center gap-1 rounded-full border bg-card px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground shadow-xs outline-none",
        "transition-opacity hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        !collapsed && "opacity-0 group-hover/node:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
      )}
      style={{ left, top: CARD_HEIGHT / 2 }}
    >
      {collapsed ? (
        <>
          {busy && <span className={cn("size-1.5 rounded-full", CREW_DOT[busy])} aria-hidden="true" />}
          +{hidden.count}
        </>
      ) : (
        <Minus aria-hidden="true" className="size-3" />
      )}
    </button>
  )
}

function MemberDetails({ member, name }: { member: CrewMember; name: string }) {
  const task = member.firstUserMessage?.replace(/\s+/g, " ").trim()
  const folder = member.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const facts: Array<[string, string]> = []
  if (member.model) facts.push(["Model", shortenModel(member.model)])
  if (member.device) facts.push(["Device", member.device.name])
  if (folder) facts.push(["Folder", folder])
  if (member.startedAt) facts.push(["Started", startedLabel(member.startedAt)])
  if (member.turnCount) facts.push(["Turns", String(member.turnCount)])
  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      <p className="font-medium">{name}</p>
      {task && task !== name && <p className="line-clamp-3 text-muted-foreground">{task}</p>}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {facts.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="truncate tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
