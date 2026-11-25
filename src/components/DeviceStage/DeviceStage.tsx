import { Activity, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { Laptop, Loader2, Server } from "lucide-react"
import { createPaneLifetime, DevicePaneProvider, PaneLifetimeProvider, type Machine } from "@/contexts/DevicePaneContext"
import { commitDeviceSwitch, LOCAL_DEVICE_ID, setDeviceSwitchTransition } from "@/lib/device"
import { shownDeviceTheme, subscribeDeviceThemes } from "@/lib/deviceThemes"
import { themeClassName } from "@/lib/themes"
import { cn } from "@/lib/utils"
import { DevicePager } from "./DevicePager"
import { animateSpring, releaseDirection, rubberBand } from "./motion"
import { useDeviceSwipe } from "./useDeviceSwipe"

export interface StagePane {
  key: string
  deviceId: string
}

interface DeviceStageProps {
  panes: readonly StagePane[]
  activeDeviceId: string
  /** Every machine in swipe order, left to right. */
  machines: readonly Machine[]
  swipeEnabled: boolean
  renderPane: (deviceId: string) => ReactNode
}

/** How long the page dots stay up after a move. */
const PAGER_LINGER_MS = 900
/** A machine opened for the first time hides behind its poster until its UI stops changing this long... */
const POSTER_QUIET_MS = 160
/** ...or this long at most. */
const POSTER_MAX_MS = 1500

function useShownTheme(deviceId: string) {
  return useSyncExternalStore(subscribeDeviceThemes, () => shownDeviceTheme(deviceId))
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

/**
 * One machine's UI. Off screen it stays mounted under a hidden Activity: its
 * state, scroll positions and drafts wait as they were, while its effects
 * (sockets, polling) stop until it is shown again. It wears its machine's
 * theme, so two machines side by side during a swipe each look like
 * themselves. The stage moves the outer element, which stays registered
 * while hidden (React detaches refs inside a hidden Activity) and is
 * transparent to the pointer unless its machine is on screen. It is memoized
 * because React hides a hidden Activity's content again on every commit that
 * renders it, which would blank a background pane the stage is showing.
 */
const DevicePane = memo(function DevicePane({ deviceId, visible, register, render }: {
  deviceId: string
  visible: boolean
  register: (deviceId: string, element: HTMLDivElement | null) => void
  render: (deviceId: string) => ReactNode
}) {
  const theme = useShownTheme(deviceId)
  const ref = useCallback((element: HTMLDivElement | null) => register(deviceId, element), [deviceId, register])
  // Outside the Activity, so this runs only when the pane is created and removed.
  const [lifetime] = useState(createPaneLifetime)
  useEffect(() => () => lifetime.end(), [lifetime])
  return (
    <div
      ref={ref}
      data-device-pane={deviceId}
      className={cn("theme-scope absolute inset-0", themeClassName(theme), !visible && "pointer-events-none")}
    >
      <Activity mode={visible ? "visible" : "hidden"}>
        <div className="size-full overflow-hidden bg-canvas text-foreground">
          <PaneLifetimeProvider value={lifetime}>
            <DevicePaneProvider value={deviceId}>{render(deviceId)}</DevicePaneProvider>
          </PaneLifetimeProvider>
        </div>
      </Activity>
    </div>
  )
})

/** Stands in for a machine whose UI has not been opened yet: its colors, its name. */
function DevicePoster({ machine, connecting, register }: {
  machine: Machine
  connecting: boolean
  register: (element: HTMLDivElement | null) => void
}) {
  const theme = useShownTheme(machine.id)
  const Icon = machine.id === LOCAL_DEVICE_ID ? Laptop : Server
  return (
    <div
      ref={register}
      aria-hidden
      className={cn(
        "theme-scope absolute inset-0 flex items-center justify-center bg-canvas text-foreground transition-opacity duration-200",
        themeClassName(theme),
      )}
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Icon className="size-8" strokeWidth={1.5} />
        <span className="text-sm font-medium text-foreground">{machine.name}</span>
        <Loader2 className={cn("size-4 animate-spin transition-opacity", !connecting && "opacity-0")} />
      </div>
    </div>
  )
}

/**
 * Show a background pane's last frame without waking it: the hidden Activity
 * put an inline `display: none` on the pane's content, and hideFrame puts
 * back exactly that, so React finds what it left when it shows or hides it.
 */
function frameOf(pane: HTMLElement): HTMLElement | null {
  return pane.firstElementChild instanceof HTMLElement ? pane.firstElementChild : null
}

function showFrame(pane: HTMLElement): void {
  frameOf(pane)?.style.removeProperty("display")
}

function hideFrame(pane: HTMLElement): void {
  frameOf(pane)?.style.setProperty("display", "none", "important")
}

function place(element: HTMLElement | null | undefined, x: number | null): void {
  if (!element) return
  element.style.transform = x === null ? "" : `translate3d(${x}px, 0, 0)`
  element.style.willChange = x === null ? "" : "transform"
}

interface Move {
  from: string
  /** The machine coming in, or null while pulled past the last one. */
  to: string | null
  direction: -1 | 1
  /** How far the current pane has moved; the incoming one sits a width beyond. */
  offset: number
}

/**
 * Lays the machines out side by side and moves between them: a swipe drags
 * them with the fingers, an explicit switch (menu, shortcut) slides them, and
 * the page dots say where you are.
 */
export function DeviceStage({ panes, activeDeviceId, machines, swipeEnabled, renderPane }: DeviceStageProps) {
  const paneElements = useRef(new Map<string, HTMLDivElement>())
  const posterElement = useRef<HTMLDivElement | null>(null)
  const pagerElement = useRef<HTMLDivElement | null>(null)
  const stageElement = useRef<HTMLDivElement | null>(null)
  const move = useRef<Move | null>(null)
  const animation = useRef<{ cancel: () => void } | null>(null)
  const pagerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [poster, setPoster] = useState<{ id: string; connecting: boolean } | null>(null)
  const [pager, setPager] = useState({ visible: false, from: activeDeviceId, to: activeDeviceId })
  const activeRef = useRef(activeDeviceId)
  activeRef.current = activeDeviceId
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const mountedPanes = useRef(new Set<string>())
  mountedPanes.current = new Set(panes.map((pane) => pane.deviceId))

  const registerPane = useCallback((deviceId: string, element: HTMLDivElement | null) => {
    if (element) paneElements.current.set(deviceId, element)
    else paneElements.current.delete(deviceId)
  }, [])

  const width = () => stageElement.current?.clientWidth || window.innerWidth

  const incomingElement = (deviceId: string | null): HTMLElement | null => {
    if (!deviceId) return null
    return mountedPanes.current.has(deviceId) ? paneElements.current.get(deviceId) ?? null : posterElement.current
  }

  /** Put both panes where the current move says, and the dots with them. */
  const paint = useCallback(() => {
    const current = move.current
    if (!current) return
    const w = width()
    place(paneElements.current.get(current.from), current.offset)
    const incoming = incomingElement(current.to)
    place(incoming, current.to ? current.offset + current.direction * w : null)
    if (incoming && current.to && mountedPanes.current.has(current.to)) showFrame(incoming)
    pagerElement.current?.style.setProperty("--pager-to", current.to ? String(Math.min(1, Math.abs(current.offset) / w)) : "0")
  }, [])

  const registerPoster = useCallback((element: HTMLDivElement | null) => {
    posterElement.current = element
    paint()
  }, [paint])

  const showPager = useCallback((from: string, to: string) => {
    if (pagerTimer.current) clearTimeout(pagerTimer.current)
    pagerTimer.current = null
    setPager({ visible: true, from, to })
  }, [])

  const settlePager = useCallback((at: string) => {
    pagerElement.current?.style.setProperty("--pager-to", "0")
    setPager({ visible: true, from: at, to: at })
    if (pagerTimer.current) clearTimeout(pagerTimer.current)
    pagerTimer.current = setTimeout(() => setPager((current) => ({ ...current, visible: false })), PAGER_LINGER_MS)
  }, [])

  /** Point the move at the machine on `direction`'s side, waking its frame or poster. */
  const aim = useCallback((direction: -1 | 1, target?: string) => {
    const current = move.current
    if (!current) return
    const order = machinesRef.current.map((machine) => machine.id)
    const next = target ?? order[order.indexOf(current.from) + direction] ?? null
    if (current.to === next && current.direction === direction) return
    // Put the one aimed at before back to sleep.
    if (current.to && current.to !== next) {
      const before = incomingElement(current.to)
      place(before, null)
      if (mountedPanes.current.has(current.to) && before) hideFrame(before)
    }
    current.to = next
    current.direction = direction
    if (next) {
      if (mountedPanes.current.has(next)) {
        const frame = paneElements.current.get(next)
        if (frame) showFrame(frame)
        setPoster(null)
      } else {
        setPoster({ id: next, connecting: false })
      }
      showPager(current.from, next)
    }
  }, [showPager])

  const begin = (): Move => {
    animation.current?.cancel()
    animation.current = null
    move.current ??= { from: activeRef.current, to: null, direction: 1, offset: 0 }
    return move.current
  }

  /** Back to rest on the machine the move started from. */
  const cancelMove = useCallback(() => {
    const current = move.current
    if (!current) return
    place(paneElements.current.get(current.from), null)
    if (current.to) {
      const incoming = incomingElement(current.to)
      place(incoming, null)
      if (mountedPanes.current.has(current.to) && incoming) hideFrame(incoming)
    }
    move.current = null
    setPoster(null)
    settlePager(current.from)
  }, [settlePager])

  /** The incoming machine is fully on screen: make it the active one. */
  const land = useCallback(() => {
    const current = move.current
    if (!current?.to) return cancelMove()
    const target = current.to
    const outgoing = paneElements.current.get(current.from)
    // Hide it now, as React is about to: reset, it would cover the new one for a frame.
    if (outgoing) {
      hideFrame(outgoing)
      place(outgoing, null)
    }
    place(paneElements.current.get(target), null)
    const cold = !mountedPanes.current.has(target)
    move.current = null
    if (cold) {
      place(posterElement.current, null)
      setPoster({ id: target, connecting: true })
    }
    commitDeviceSwitch(target)
    settlePager(target)
  }, [cancelMove, settlePager])

  /** Spring the current move to rest: onto the next machine (`direction`), or back (0). */
  const settle = useCallback((direction: -1 | 0 | 1, velocity: number) => {
    const current = move.current
    if (!current) return
    const target = direction === 0 ? 0 : -direction * width()
    const run = animateSpring(current.offset, target, velocity, (value) => {
      current.offset = value
      paint()
    })
    animation.current = run
    void run.done.then(() => {
      if (animation.current !== run) return
      animation.current = null
      if (direction === 0) cancelMove()
      else land()
    })
  }, [cancelMove, land, paint])

  // An explicit switch slides the machines past like a swipe would.
  useEffect(() => {
    setDeviceSwitchTransition((target) => {
      const from = activeRef.current
      if (target === from || prefersReducedMotion() || !machinesRef.current.some((machine) => machine.id === target)) {
        if (move.current) cancelMove()
        commitDeviceSwitch(target)
        if (target !== from) settlePager(target)
        return
      }
      if (move.current && move.current.from !== from) cancelMove()
      const order = machinesRef.current.map((machine) => machine.id)
      const direction: -1 | 1 = order.indexOf(target) < order.indexOf(from) ? -1 : 1
      begin()
      aim(direction, target)
      // A poster rendered this frame is placed by its ref; give it that frame.
      requestAnimationFrame(() => settle(direction, 0))
    })
    return () => setDeviceSwitchTransition(null)
  }, [aim, cancelMove, settle, settlePager])

  // A swipe that catches a sliding pane carries on from where the pane is.
  const swipeBase = useRef(0)
  useDeviceSwipe(swipeEnabled && machines.length > 1, {
    surface: () => paneElements.current.get(activeRef.current) ?? null,
    onStart: () => {
      const caught = move.current?.to ? move.current.offset : 0
      begin()
      swipeBase.current = caught
    },
    onMove: (moved) => {
      const current = begin()
      const offset = swipeBase.current + moved
      const direction: -1 | 1 = offset < 0 ? 1 : -1
      aim(direction)
      current.offset = current.to ? offset : rubberBand(offset, width())
      paint()
    },
    onRelease: (moved, velocity, projected) => {
      const current = move.current
      if (!current) return
      const offset = swipeBase.current + moved
      const order = machinesRef.current.map((machine) => machine.id)
      const index = order.indexOf(current.from)
      const direction = current.to
        ? releaseDirection(offset, velocity, width(), { previous: index > 0, next: index < order.length - 1 }, swipeBase.current + projected)
        : 0
      settle(direction, direction === 0 && !current.to ? 0 : velocity)
    },
  })

  // A machine opened for the first time: lift its poster once its UI has drawn itself.
  const posterId = poster?.connecting ? poster.id : null
  useLayoutEffect(() => {
    if (!posterId || posterId !== activeDeviceId) return
    const frame = paneElements.current.get(posterId)
    if (!frame) return
    let quiet: ReturnType<typeof setTimeout> | null = null
    const lift = () => {
      observer.disconnect()
      if (quiet) clearTimeout(quiet)
      clearTimeout(cap)
      const element = posterElement.current
      if (!element) return setPoster(null)
      element.style.opacity = "0"
      element.addEventListener("transitionend", () => setPoster(null), { once: true })
      setTimeout(() => setPoster(null), 300)
    }
    const observer = new MutationObserver(() => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(lift, POSTER_QUIET_MS)
    })
    observer.observe(frame, { childList: true, subtree: true, characterData: true })
    quiet = setTimeout(lift, POSTER_QUIET_MS)
    const cap = setTimeout(lift, POSTER_MAX_MS)
    return () => {
      observer.disconnect()
      if (quiet) clearTimeout(quiet)
      clearTimeout(cap)
    }
  }, [posterId, activeDeviceId])

  // Back or forward changed the machine during a move (land() clears the move
  // before it commits): drop the move without committing, before the paint.
  useLayoutEffect(() => {
    const current = move.current
    if (!current || current.from === activeDeviceId) return
    animation.current?.cancel()
    animation.current = null
    move.current = null
    place(paneElements.current.get(current.from), null)
    const incoming = incomingElement(current.to)
    place(incoming, null)
    // React shows the machine now active; a frame shown only for the move goes back as React left it.
    if (incoming && current.to && current.to !== activeDeviceId && mountedPanes.current.has(current.to)) hideFrame(incoming)
    setPoster(null)
    settlePager(activeDeviceId)
  }, [activeDeviceId, settlePager])

  useEffect(() => () => {
    animation.current?.cancel()
    if (pagerTimer.current) clearTimeout(pagerTimer.current)
  }, [])

  const posterMachine = poster ? machines.find((machine) => machine.id === poster.id) : undefined

  return (
    <div ref={stageElement} className="fixed inset-0 overflow-hidden">
      {panes.map((pane) => (
        <DevicePane
          key={pane.key}
          deviceId={pane.deviceId}
          visible={pane.deviceId === activeDeviceId}
          register={registerPane}
          render={renderPane}
        />
      ))}
      {posterMachine && (
        <DevicePoster machine={posterMachine} connecting={poster?.connecting ?? false} register={registerPoster} />
      )}
      {machines.length > 1 && (
        <DevicePager ref={pagerElement} machines={machines} from={pager.from} to={pager.to} visible={pager.visible} />
      )}
    </div>
  )
}
