import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react"
import { WifiOff, Loader2 } from "lucide-react"
import App from "@/App"
import {
  getActiveDeviceId,
  getActiveDeviceScope,
  getActiveIdentity,
  getDeviceConnectionRevision,
  switchDevice,
  LOCAL_DEVICE_ID,
} from "@/lib/device"
import { knowsDeviceTheme, rememberDeviceTheme, shownDeviceTheme, subscribeDeviceThemes } from "@/lib/deviceThemes"
import { matchDeviceSwitchIndex, matchDeviceCycle } from "@/lib/keybindings"
import { useMachineSwipe } from "@/lib/machineSwipe"
import { revealSessionPath } from "@/lib/revealSession"
import { applyTheme } from "@/lib/themes"
import { deviceTheme, useDevices, type TestResult } from "@/hooks/useDevices"
import type { MintFailureCode } from "../../shared/contracts/hub"
import { SessionInventoryProvider } from "@/contexts/SessionInventoryContext"
import { PendingHumanInputProvider } from "@/contexts/PendingHumanInputContext"
import { MachinesProvider } from "@/contexts/DevicePaneContext"
import { DeviceStage, type StagePane } from "@/components/DeviceStage/DeviceStage"
import { Button } from "@/components/ui/button"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"

/**
 * Why the hub cannot use the active remote device. Only a bad password cannot
 * heal by itself; a refusal carries the device's own text once a test read it.
 */
type DeviceProblem =
  | { kind: "unreachable" | "bad-password" }
  | { kind: "refused"; detail?: string }

const BANNER: Record<DeviceProblem["kind"], { title: string; description: (device: string) => string }> = {
  unreachable: {
    title: "Remote device unavailable",
    description: (device) => `Can’t reach ${device}. Cogpit will keep retrying.`,
  },
  "bad-password": {
    title: "Device credentials need attention",
    description: (device) => `${device} rejected the stored password. Update it in Devices.`,
  },
  refused: {
    title: "Device not admitting this account",
    description: (device) => `${device} is not admitting this account right now. Cogpit will keep retrying.`,
  },
}

function bannerDescription(problem: DeviceProblem, device: string): string {
  if (problem.kind === "refused" && problem.detail) return `${problem.detail} Cogpit will keep retrying.`
  return BANNER[problem.kind].description(device)
}

/** The hub's own verdicts (`X-Cogpit-Hub-Error`) that name a problem other than an outage. */
const HUB_ERROR_PROBLEMS = new Map<string, DeviceProblem["kind"]>(Object.entries({
  DEVICE_AUTH_FAILED: "bad-password",
  DEVICE_REFUSED: "refused",
} satisfies Record<Exclude<MintFailureCode, "DEVICE_UNREACHABLE">, DeviceProblem["kind"]>))

function problemFromHubError(reason: string | undefined): DeviceProblem {
  return { kind: HUB_ERROR_PROBLEMS.get(reason ?? "") ?? "unreachable" }
}

function problemFromTest(result: TestResult): DeviceProblem | null {
  if (result.ok) return null
  if (result.reachable && result.authState === "bad-password") return { kind: "bad-password" }
  if (result.code === "DEVICE_REFUSED") return { kind: "refused", detail: result.error }
  return { kind: "unreachable" }
}

/** Machines kept alive at once, the one on screen included. */
const MAX_PANES = 5

interface PaneEntry extends StagePane {
  lastUsed: number
}

/**
 * The panes after `activeDeviceId` comes on screen: it is (re)keyed and
 * marked most recently used, background panes whose key went stale or whose
 * device left the registry are dropped, and the least recently used go once
 * there are more than {@link MAX_PANES}. Order is kept.
 */
export function nextPanes(
  previous: readonly PaneEntry[],
  { activeDeviceId, identityKey, retries, listedIds }: {
    activeDeviceId: string
    identityKey: string | null
    retries: Readonly<Record<string, number>>
    /** The registry's devices, or null while it loads. */
    listedIds: readonly string[] | null
  },
): PaneEntry[] {
  const keyOf = (deviceId: string) =>
    `${deviceId}:${getDeviceConnectionRevision(deviceId)}:${identityKey ?? ""}:${retries[deviceId] ?? 0}`
  const listed = (deviceId: string) => deviceId === LOCAL_DEVICE_ID || listedIds === null || listedIds.includes(deviceId)
  const used = Math.max(0, ...previous.map((entry) => entry.lastUsed)) + 1
  let next = previous
    .filter((entry) => entry.deviceId === activeDeviceId || (entry.key === keyOf(entry.deviceId) && listed(entry.deviceId)))
    .map((entry) => entry.deviceId === activeDeviceId ? { ...entry, key: keyOf(activeDeviceId), lastUsed: used } : entry)
  if (!next.some((entry) => entry.deviceId === activeDeviceId)) {
    next = [...next, { deviceId: activeDeviceId, key: keyOf(activeDeviceId), lastUsed: used }]
  }
  while (next.length > MAX_PANES) {
    const oldest = next.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b))
    next = next.filter((entry) => entry !== oldest)
  }
  return next
}

/**
 * Owns the active device and keeps every recently used machine's {@link App}
 * mounted, one pane each, so switching back to a machine finds it as it was.
 *
 * Only the active pane is visible and runs effects (DeviceStage hides the
 * others under Activity), so sockets, polling and in-flight work belong to the
 * machine on screen while the others keep their state. A pane is keyed by its
 * device, that device's connection revision, the signed-in account and its
 * retries: a same-id host/account change, a sign-in change or a retry after an
 * outage remounts it, and a background pane whose key goes stale is dropped
 * rather than remounted out of sight. Panes keep their DOM order, since moving
 * a pane would reload every frame inside it.
 *
 * The device id is derived from the URL ("/d/:id/..." → id, else "local"). We
 * re-derive on `cogpit-device-changed` (a committed switch) and on `popstate`
 * (back/forward across a device boundary). Explicit switches go through
 * DeviceStage, which starts the slide and commits while it plays.
 *
 * The key also carries the signed-in account (`cogpit-identity-changed`,
 * dispatched by setActiveIdentity when useMe settles /api/me): login, logout,
 * and user switches remount App so every mount-time storage read (usePermissions,
 * useSessionHistory, useLocalStorage consumers) re-runs through the
 * identity-scoped deviceScopedKey. Personal edition never dispatches.
 *
 * Also hosted here because they span machines:
 * - device keyboard shortcuts (platform chord 1..9 jump, platform chord 0 cycle)
 * - the banner for an active remote device the hub cannot use
 * - the page's theme, which is the active machine's own
 *
 * Each pane gets its own session inventory provider, so the sidebar and
 * Mission Control share one poll scoped to that machine.
 */
export function DeviceRoot() {
  const [activeDeviceId, setActiveDeviceId] = useState(getActiveDeviceId)
  const [connectionRevision, setConnectionRevision] = useState(
    () => getDeviceConnectionRevision(getActiveDeviceId()),
  )
  const [identityKey, setIdentityKey] = useState(getActiveIdentity)
  const [retries, setRetries] = useState<Readonly<Record<string, number>>>({})
  const [problem, setProblem] = useState<DeviceProblem | null>(null)
  const [retrying, setRetrying] = useState(false)
  const { devices, loading: devicesLoading, testDevice } = useDevices()
  const swipeEnabled = useMachineSwipe()

  useEffect(() => {
    const sync = () => {
      const next = getActiveDeviceId()
      setActiveDeviceId((prev) => (prev === next ? prev : next))
      setConnectionRevision(getDeviceConnectionRevision(next))
    }
    window.addEventListener("cogpit-device-changed", sync)
    window.addEventListener("popstate", sync)
    return () => {
      window.removeEventListener("cogpit-device-changed", sync)
      window.removeEventListener("popstate", sync)
    }
  }, [])

  useEffect(() => {
    const syncScope = (event: Event) => {
      const detail = (event as CustomEvent<{
        deviceId?: string
        connectionRevision?: number
      }>).detail
      if (detail?.deviceId !== getActiveDeviceId()) return
      setConnectionRevision(getDeviceConnectionRevision(detail.deviceId))
    }
    window.addEventListener("cogpit-device-scope-changed", syncScope)
    return () => window.removeEventListener("cogpit-device-scope-changed", syncScope)
  }, [])

  useEffect(() => {
    const sync = () => setIdentityKey(getActiveIdentity())
    window.addEventListener("cogpit-identity-changed", sync)
    return () => window.removeEventListener("cogpit-identity-changed", sync)
  }, [])

  // Deep-link entry point for desktop notification clicks. Registered here —
  // above the keyed App remount — so it exists for the whole app lifetime and
  // doubles as the "renderer is ready" ack the main process retries against.
  useEffect(() => {
    window.__cogpitRevealSession = revealSessionPath
    return () => {
      delete window.__cogpitRevealSession
    }
  }, [])

  // Device shortcuts: slot 1 is always this machine, 2..9 follow registry order.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ids = [LOCAL_DEVICE_ID, ...devices.map((device) => device.id)]
      const current = getActiveDeviceId()
      let target: string | undefined
      const index = matchDeviceSwitchIndex(event)
      if (index !== null) {
        target = ids[index - 1]
      } else if (matchDeviceCycle(event)) {
        const pos = ids.indexOf(current)
        target = ids[(pos + 1) % ids.length]
      }
      if (!target || target === current) return
      event.preventDefault()
      switchDevice(target)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [devices])

  // Reset banner state whenever the active device changes.
  useEffect(() => {
    setProblem(null)
    setRetrying(false)
  }, [activeDeviceId, connectionRevision])

  const retry = useCallback(async () => {
    // Switching devices or changing credentials resets the banner while a
    // probe can still be in flight; its answer is about the old target.
    const scope = getActiveDeviceScope()
    const stillCurrent = () => getActiveDeviceScope() === scope
    setRetrying(true)
    try {
      const next = problemFromTest(await testDevice(activeDeviceId))
      if (!stillCurrent()) return
      setProblem(next)
      // Remount App so every data hook refetches from the recovered device.
      if (next === null) setRetries((current) => ({ ...current, [activeDeviceId]: (current[activeDeviceId] ?? 0) + 1 }))
    } finally {
      if (stillCurrent()) setRetrying(false)
    }
  }, [activeDeviceId, testDevice])

  // Connectivity banner: authFetch dispatches this only for the hub's own
  // proxy failures, never for an error the device itself reported. A repeat of
  // the current verdict keeps the banner, and any text a test already read.
  const problemKind = problem?.kind
  useEffect(() => {
    const onUnreachable = (event: Event) => {
      const detail = (event as CustomEvent<{ deviceId?: string; reason?: string }>).detail
      if (!detail?.deviceId || detail.deviceId !== getActiveDeviceId()) return
      const next = problemFromHubError(detail.reason)
      if (next.kind === problemKind) return
      setProblem(next)
      // The hub's verdict carries no reason; ask the device for its own now.
      if (next.kind === "refused") void retry()
    }
    window.addEventListener("cogpit-device-unreachable", onUnreachable)
    return () => window.removeEventListener("cogpit-device-unreachable", onUnreachable)
  }, [problemKind, retry])

  // Auto-retry every 10s while the banner is visible. A bad password won't
  // self-heal, so we stop polling once that's detected.
  const selfHealing = problem !== null && problem.kind !== "bad-password"
  useEffect(() => {
    if (!selfHealing) return
    const timer = setInterval(() => void retry(), 10_000)
    return () => clearInterval(timer)
  }, [selfHealing, retry])

  const deviceName = devices.find((d) => d.id === activeDeviceId)?.name ?? activeDeviceId

  // What the hub last heard each machine wear, for the swipe and first paint
  // of a machine this browser has not met. Only a hint: the hello can be older
  // than a pick or a read since, which a machine's own pane keeps current.
  useEffect(() => {
    for (const device of devices) {
      const theme = deviceTheme(device)
      if (theme && !knowsDeviceTheme(device.id)) rememberDeviceTheme(device.id, theme, "host")
    }
  }, [devices])

  // The page, and everything portaled to it, wears the active machine's theme.
  const activeTheme = useSyncExternalStore(subscribeDeviceThemes, () => shownDeviceTheme(activeDeviceId))
  useLayoutEffect(() => applyTheme(activeTheme), [activeTheme])

  const machines = useMemo(
    () => [{ id: LOCAL_DEVICE_ID, name: "This machine" }, ...devices.map(({ id, name }) => ({ id, name }))],
    [devices],
  )

  const listedIds = devicesLoading ? null : devices.map((device) => device.id)
  const paneInputs = JSON.stringify([activeDeviceId, connectionRevision, identityKey, retries, listedIds])
  const [paneState, setPaneState] = useState(() => ({
    inputs: paneInputs,
    panes: nextPanes([], { activeDeviceId, identityKey, retries, listedIds }),
  }))
  let panes = paneState.panes
  if (paneState.inputs !== paneInputs) {
    panes = nextPanes(paneState.panes, { activeDeviceId, identityKey, retries, listedIds })
    setPaneState({ inputs: paneInputs, panes })
  }

  const renderPane = useCallback(() => (
    <SessionInventoryProvider>
      <PendingHumanInputProvider>
        <App />
      </PendingHumanInputProvider>
    </SessionInventoryProvider>
  ), [])

  return (
    <>
      {problem && activeDeviceId !== LOCAL_DEVICE_ID && (
        <Alert
          role="status"
          className="fixed inset-x-3 top-3 z-40 mx-auto max-w-2xl border-warning/40 bg-popover shadow-md"
        >
          <WifiOff data-icon="inline-start" className="text-warning" />
          <AlertTitle>{BANNER[problem.kind].title}</AlertTitle>
          <AlertDescription>{bannerDescription(problem, deviceName)}</AlertDescription>
          <div className="col-start-2 mt-2 flex flex-wrap gap-2">
            {selfHealing && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => void retry()}
                disabled={retrying}
              >
                {retrying && <Loader2 data-icon="inline-start" className="animate-spin" />}
                {retrying ? "Retrying" : "Retry now"}
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              onClick={() => switchDevice(LOCAL_DEVICE_ID)}
            >
              Switch to this machine
            </Button>
          </div>
        </Alert>
      )}
      <MachinesProvider value={machines}>
        <DeviceStage
          panes={panes}
          activeDeviceId={activeDeviceId}
          machines={machines}
          swipeEnabled={swipeEnabled}
          renderPane={renderPane}
        />
      </MachinesProvider>
    </>
  )
}
