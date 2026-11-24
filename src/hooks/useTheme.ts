import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { ThemeContext } from "@/contexts/AppContext"
import { useDeviceId, useInDevicePane } from "@/contexts/DevicePaneContext"
import { authFetch, isRemoteClient } from "@/lib/auth"
import { LOCAL_DEVICE_ID } from "@/lib/device"
import {
  keepsOwnDeviceTheme,
  localOnlyDeviceTheme,
  previewDeviceTheme,
  rememberDeviceTheme,
  savedDeviceTheme,
  shownDeviceTheme,
  subscribeDeviceThemes,
} from "@/lib/deviceThemes"
import { applyTheme, legacyTheme, type ThemeId } from "@/lib/themes"
import { APPEARANCE_PATH, parseThemeId } from "../../shared/contracts/appearance"

/** Counts each machine's picks, so an answer to an earlier read or save cannot land over a newer pick. */
const picks = new Map<string, number>()
const pickOf = (deviceId: string) => picks.get(deviceId) ?? 0

/**
 * Ask the machine to wear `theme` for everyone. One that refuses the account
 * (403) or cannot keep a theme leaves the pick on this computer only.
 */
async function saveMachineTheme(deviceId: string, theme: ThemeId): Promise<void> {
  const pick = pickOf(deviceId)
  let source: "host" | "forbidden" | "unsupported"
  try {
    const response = await authFetch(APPEARANCE_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    })
    source = response.ok ? "host" : response.status === 403 ? "forbidden" : "unsupported"
  } catch {
    source = "unsupported"
  }
  if (pickOf(deviceId) === pick) rememberDeviceTheme(deviceId, theme, source)
}

/** Learn the theme the visible machine wears. */
async function readMachineTheme(deviceId: string, signal: AbortSignal): Promise<void> {
  const pick = pickOf(deviceId)
  let reported: ThemeId | null
  try {
    const response = await authFetch(APPEARANCE_PATH, { signal, background: true })
    // A machine from before themes were its own keeps whatever this computer picked.
    if (!response.ok) return
    reported = parseThemeId(((await response.json()) as { theme?: unknown } | null)?.theme)
  } catch {
    return
  }
  if (signal.aborted || pickOf(deviceId) !== pick) return
  if (reported) {
    // An account that may not change the machine's theme keeps its own pick.
    if (!keepsOwnDeviceTheme(deviceId)) rememberDeviceTheme(deviceId, reported, "host")
    return
  }
  // Nobody picked one yet. The machine's own window offers the theme it wore
  // before themes moved to machines; a pick made for it elsewhere is offered too.
  const offer = localOnlyDeviceTheme(deviceId)
    ?? (deviceId === LOCAL_DEVICE_ID && !isRemoteClient() ? legacyTheme() : null)
  if (offer) await saveMachineTheme(deviceId, offer)
}

/**
 * The theme of the machine this UI shows. Inside DeviceRoot it is the
 * machine's own, read from it whenever its pane is shown or the window comes
 * back, and DeviceRoot dresses the page in it. Outside (a shared session) it
 * is this browser's, and the hook dresses the page itself.
 */
export function useTheme(): ThemeContext {
  const inPane = useInDevicePane()
  const deviceId = useDeviceId()
  const theme = useSyncExternalStore(subscribeDeviceThemes, () => savedDeviceTheme(deviceId))
  const activeTheme = useSyncExternalStore(subscribeDeviceThemes, () => shownDeviceTheme(deviceId))

  useEffect(() => {
    if (!inPane) applyTheme(activeTheme)
  }, [inPane, activeTheme])

  useEffect(() => {
    if (!inPane) return
    let controller = new AbortController()
    const read = () => {
      controller.abort()
      controller = new AbortController()
      void readMachineTheme(deviceId, controller.signal)
    }
    read()
    window.addEventListener("focus", read)
    return () => {
      controller.abort()
      window.removeEventListener("focus", read)
    }
  }, [inPane, deviceId])

  const setTheme = useCallback((id: ThemeId) => {
    previewDeviceTheme(deviceId, null)
    picks.set(deviceId, pickOf(deviceId) + 1)
    if (inPane) {
      // Shown at once; the machine's answer says who keeps it.
      rememberDeviceTheme(deviceId, id, "host")
      void saveMachineTheme(deviceId, id)
    } else {
      rememberDeviceTheme(deviceId, id, "unsupported")
    }
  }, [inPane, deviceId])

  const setPreview = useCallback((id: ThemeId | null) => previewDeviceTheme(deviceId, id), [deviceId])

  return { theme, activeTheme, setTheme, setPreview }
}
