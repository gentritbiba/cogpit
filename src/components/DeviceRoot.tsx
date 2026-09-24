import { useCallback, useEffect, useState } from "react"
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
import { matchDeviceSwitchIndex, matchDeviceCycle } from "@/lib/keybindings"
import { revealSessionPath } from "@/lib/revealSession"
import { useDevices, type TestResult } from "@/hooks/useDevices"
import type { MintFailureCode } from "../../shared/contracts/hub"
import { SessionInventoryProvider } from "@/contexts/SessionInventoryContext"
import { PendingHumanInputProvider } from "@/contexts/PendingHumanInputContext"
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

/**
 * Owns the active device identity and remounts the whole {@link App} subtree
 * (via a React `key`) whenever the active device changes.
 *
 * A keyed remount tears down every App-level hook: PTY sockets, session
 * subscriptions, in-flight fetches. Switching devices therefore starts from a
 * clean slate instead of leaking one device's live state into another. Module
 * caches survive the remount but are device-scoped by key (see sessionCache /
 * sessionPrefetch / useSessionHistory / usePermissions), so a switch-back stays
 * warm without cross-device collisions.
 *
 * The device id is derived from the URL ("/d/:id/..." → id, else "local"). We
 * re-derive on `cogpit-device-changed` (explicit switchDevice) and on `popstate`
 * (back/forward across a device boundary), updating state only when the id
 * actually changes so intra-device navigation never forces a remount.
 *
 * The key also carries the signed-in account (`cogpit-identity-changed`,
 * dispatched by setActiveIdentity when useMe settles /api/me): login, logout,
 * and user switches remount App so every mount-time storage read (usePermissions,
 * useSessionHistory, useLocalStorage consumers) re-runs through the
 * identity-scoped deviceScopedKey. Personal edition never dispatches — no
 * remount, no hold, boot behavior is byte-identical to builds without sign-in.
 *
 * Also hosted here because they must survive the remount:
 * - device keyboard shortcuts (platform chord 1..9 jump, platform chord 0 cycle)
 * - the banner for an active remote device the hub cannot use
 *
 * The session inventory provider is keyed here rather than inside App so the
 * sidebar and Mission Control share one poll, scoped to the active device.
 */
export function DeviceRoot() {
  const [activeDeviceId, setActiveDeviceId] = useState(getActiveDeviceId)
  const [connectionRevision, setConnectionRevision] = useState(
    () => getDeviceConnectionRevision(getActiveDeviceId()),
  )
  const [identityKey, setIdentityKey] = useState(getActiveIdentity)
  const [retryNonce, setRetryNonce] = useState(0)
  const [problem, setProblem] = useState<DeviceProblem | null>(null)
  const [retrying, setRetrying] = useState(false)
  const { devices, testDevice } = useDevices()

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
      if (next === null) setRetryNonce((n) => n + 1)
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
      <SessionInventoryProvider key={`${activeDeviceId}:${connectionRevision}:${retryNonce}:${identityKey ?? ""}`}>
        <PendingHumanInputProvider>
          <App />
        </PendingHumanInputProvider>
      </SessionInventoryProvider>
    </>
  )
}
