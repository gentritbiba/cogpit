import { useCallback, useEffect, useRef, useState } from "react"
import { WifiOff, Loader2 } from "lucide-react"
import App from "@/App"
import { getActiveDeviceId, switchDevice, LOCAL_DEVICE_ID } from "@/lib/device"
import { matchDeviceSwitchIndex, matchDeviceCycle } from "@/lib/keybindings"
import { useDevices } from "@/hooks/useDevices"

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
 * Also hosted here because they must survive the remount:
 * - device keyboard shortcuts (mod+shift+1..9 jump, mod+shift+0 cycle)
 * - the offline banner for an unreachable active remote device
 */
export function DeviceRoot() {
  const [activeDeviceId, setActiveDeviceId] = useState(getActiveDeviceId)
  const [retryNonce, setRetryNonce] = useState(0)
  const [unreachable, setUnreachable] = useState(false)
  const [badPassword, setBadPassword] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const { devices, testDevice } = useDevices()
  const devicesRef = useRef(devices)
  devicesRef.current = devices

  useEffect(() => {
    const sync = () => {
      const next = getActiveDeviceId()
      setActiveDeviceId((prev) => (prev === next ? prev : next))
    }
    window.addEventListener("cogpit-device-changed", sync)
    window.addEventListener("popstate", sync)
    return () => {
      window.removeEventListener("cogpit-device-changed", sync)
      window.removeEventListener("popstate", sync)
    }
  }, [])

  // Device shortcuts: slot 1 is always this machine, 2..9 follow registry order.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ids = [LOCAL_DEVICE_ID, ...devicesRef.current.map((d) => d.id)]
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
  }, [])

  // Unreachable banner: authFetch dispatches this on any proxied 502.
  useEffect(() => {
    const onUnreachable = (event: Event) => {
      const deviceId = (event as CustomEvent<{ deviceId?: string }>).detail?.deviceId
      if (deviceId && deviceId === getActiveDeviceId()) setUnreachable(true)
    }
    window.addEventListener("cogpit-device-unreachable", onUnreachable)
    return () => window.removeEventListener("cogpit-device-unreachable", onUnreachable)
  }, [])

  // Reset banner state whenever the active device changes.
  useEffect(() => {
    setUnreachable(false)
    setBadPassword(false)
    setRetrying(false)
  }, [activeDeviceId])

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      const result = await testDevice(activeDeviceId)
      // A reachable device that rejects the stored password (ok:false,
      // authState:"bad-password") is NOT recovered — auto-retry can't fix a
      // stale credential, so surface it and stop the remount loop.
      if (result.reachable && result.authState === "bad-password") {
        setBadPassword(true)
      } else if (result.ok) {
        setUnreachable(false)
        setBadPassword(false)
        // Remount App so every data hook refetches from the recovered device.
        setRetryNonce((n) => n + 1)
      }
    } finally {
      setRetrying(false)
    }
  }, [activeDeviceId, testDevice])

  // Auto-retry every 10s while the connectivity banner is visible. A bad
  // password won't self-heal, so we stop polling once that's detected.
  useEffect(() => {
    if (!unreachable || badPassword) return
    const timer = setInterval(() => void retry(), 10_000)
    return () => clearInterval(timer)
  }, [unreachable, badPassword, retry])

  const deviceName = devices.find((d) => d.id === activeDeviceId)?.name ?? activeDeviceId

  return (
    <>
      {unreachable && activeDeviceId !== LOCAL_DEVICE_ID && (
        <div className="fixed inset-x-0 top-0 z-[9999] flex items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300 backdrop-blur">
          <WifiOff className="size-3.5 shrink-0" />
          <span>
            {badPassword ? (
              <><span className="font-medium">{deviceName}</span> rejected the stored password — update it in Devices</>
            ) : (
              <>Can’t reach <span className="font-medium">{deviceName}</span> — retrying…</>
            )}
          </span>
          {!badPassword && (
            <button
              onClick={() => void retry()}
              disabled={retrying}
              className="rounded border border-amber-500/40 px-2 py-0.5 hover:bg-amber-500/20 disabled:opacity-50"
            >
              {retrying ? <Loader2 className="size-3 animate-spin" /> : "Retry now"}
            </button>
          )}
          <button
            onClick={() => switchDevice(LOCAL_DEVICE_ID)}
            className="rounded border border-amber-500/40 px-2 py-0.5 hover:bg-amber-500/20"
          >
            Switch to this machine
          </button>
        </div>
      )}
      <App key={`${activeDeviceId}:${retryNonce}`} />
    </>
  )
}
