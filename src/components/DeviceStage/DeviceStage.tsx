import { Activity, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { Laptop, Loader2, Server } from "lucide-react"
import { createPaneLifetime, DevicePaneProvider, PaneLifetimeProvider, type Machine } from "@/contexts/DevicePaneContext"
import { commitDeviceSwitch, LOCAL_DEVICE_ID, setDeviceSwitchTransition } from "@/lib/device"
import { shownDeviceTheme, subscribeDeviceThemes } from "@/lib/deviceThemes"
import { themeClassName } from "@/lib/themes"
import { cn } from "@/lib/utils"
import { DevicePager } from "./DevicePager"
import { StageMotion } from "./stageMotion"
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
 * themselves. The stage places the outer element, which stays registered
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
 * Lays the machines out side by side and moves between them: a swipe drags
 * them with the fingers, an explicit switch (menu, shortcut) slides them, and
 * the page dots say where you are. StageMotion does the moving.
 */
export function DeviceStage({ panes, activeDeviceId, machines, swipeEnabled, renderPane }: DeviceStageProps) {
  const paneElements = useRef(new Map<string, HTMLDivElement>())
  const posterElement = useRef<HTMLDivElement | null>(null)
  const pagerElement = useRef<HTMLDivElement | null>(null)
  const stageElement = useRef<HTMLDivElement | null>(null)
  const trackElement = useRef<HTMLDivElement | null>(null)
  const pagerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [poster, setPoster] = useState<{ id: string; connecting: boolean } | null>(null)
  // What the poster shows as soon as the motion asks, before React renders it.
  const posterFor = useRef<string | null>(null)
  const [pager, setPager] = useState({ visible: false, from: activeDeviceId, to: activeDeviceId })
  const activeRef = useRef(activeDeviceId)
  activeRef.current = activeDeviceId
  const orderRef = useRef<readonly string[]>([])
  orderRef.current = machines.map((machine) => machine.id)
  const mountedPanes = useRef(new Set<string>())
  mountedPanes.current = new Set(panes.map((pane) => pane.deviceId))

  const [motion] = useState(() => new StageMotion({
    stage: () => stageElement.current,
    track: () => trackElement.current,
    pager: () => pagerElement.current,
    pane: (id) => paneElements.current.get(id) ?? null,
    poster: () => posterElement.current,
    posterFor: () => posterFor.current,
    mounted: (id) => mountedPanes.current.has(id),
    order: () => orderRef.current,
    active: () => activeRef.current,
    reducedMotion: prefersReducedMotion,
    showPoster: (id, connecting) => {
      posterFor.current = id
      setPoster(id ? { id, connecting } : null)
    },
    showPager: (from, to) => {
      if (pagerTimer.current) clearTimeout(pagerTimer.current)
      pagerTimer.current = null
      setPager({ visible: true, from, to })
    },
    settlePager: (at) => {
      pagerElement.current?.style.setProperty("--pager-to", "0")
      setPager({ visible: true, from: at, to: at })
      if (pagerTimer.current) clearTimeout(pagerTimer.current)
      pagerTimer.current = setTimeout(() => setPager((current) => ({ ...current, visible: false })), PAGER_LINGER_MS)
    },
    commit: commitDeviceSwitch,
  }))

  const registerPane = useCallback((deviceId: string, element: HTMLDivElement | null) => {
    if (element) paneElements.current.set(deviceId, element)
    else paneElements.current.delete(deviceId)
    motion.registered()
  }, [motion])

  const registerPoster = useCallback((element: HTMLDivElement | null) => {
    posterElement.current = element
    motion.registered()
  }, [motion])

  // An explicit switch slides the machines past like a swipe would.
  useEffect(() => {
    setDeviceSwitchTransition((target) => motion.switchTo(target))
    return () => setDeviceSwitchTransition(null)
  }, [motion])

  useDeviceSwipe(swipeEnabled && machines.length > 1, {
    // The whole stage: mid-slide the pointer may be over the machine coming in, which takes no pointer events yet.
    surface: () => stageElement.current,
    onStart: () => motion.swipeStart(),
    onMove: (moved) => motion.swipeMove(moved),
    onRelease: (moved, velocity, projected) => motion.swipeRelease(moved, velocity, projected),
  })

  // React shows another machine: one a move switched to, or one Back, Forward or a link chose.
  useLayoutEffect(() => motion.activeChanged(activeDeviceId), [motion, activeDeviceId])

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
      const done = () => {
        if (posterFor.current !== posterId) return
        posterFor.current = null
        setPoster(null)
      }
      const element = posterElement.current
      if (!element) return done()
      element.style.opacity = "0"
      element.addEventListener("transitionend", done, { once: true })
      setTimeout(done, 300)
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

  useEffect(() => () => {
    motion.dispose()
    if (pagerTimer.current) clearTimeout(pagerTimer.current)
  }, [motion])

  const posterMachine = poster ? machines.find((machine) => machine.id === poster.id) : undefined

  return (
    <div ref={stageElement} className="fixed inset-0 overflow-hidden">
      <div ref={trackElement} className="absolute inset-0">
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
          <DevicePoster
            key={posterMachine.id}
            machine={posterMachine}
            connecting={poster?.connecting ?? false}
            register={registerPoster}
          />
        )}
      </div>
      {machines.length > 1 && (
        <DevicePager ref={pagerElement} machines={machines} from={pager.from} to={pager.to} visible={pager.visible} />
      )}
    </div>
  )
}
