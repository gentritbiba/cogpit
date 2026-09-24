import { authFetch } from "@/lib/auth"
import { sessionUrlIdFromFileName } from "@/lib/agents"
import { devicePathPrefix } from "@/lib/device"
import { readJson } from "@/lib/httpJson"

declare global {
  interface Window {
    /**
     * Registered by DeviceRoot once the router is mounted. The Electron main
     * process calls this (with retries) when a desktop notification is clicked,
     * instead of blindly injecting a pushState that a booting renderer would
     * drop. Its presence is the readiness ack.
     */
    __cogpitRevealSession?: (path: string) => void
  }
}

/**
 * Navigate the SPA to `path` through the history stack.
 *
 * Dispatching popstate makes both listeners react in their own domains:
 * DeviceRoot re-derives the device id (remounting App on a device change, whose
 * mount effect then loads the session from the URL), and useUrlSync loads the
 * session for an intra-device navigation.
 */
export function revealSessionPath(path: string): void {
  window.history.pushState({}, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

/** The app path that opens a transcript on the active device. */
export function sessionPath(dirName: string, fileName: string): string {
  return `${devicePathPrefix()}/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionUrlIdFromFileName(dirName, fileName))}`
}

/** Open a session known only by its id, wherever its transcript is. False when the server finds none the caller may see. */
export async function revealSessionById(sessionId: string): Promise<boolean> {
  let res: Response
  try {
    res = await authFetch(`/api/find-session/${encodeURIComponent(sessionId)}`)
  } catch {
    return false
  }
  const location = res.ok ? await readJson(res) : null
  if (typeof location?.dirName !== "string" || typeof location.fileName !== "string") return false
  revealSessionPath(sessionPath(location.dirName, location.fileName))
  return true
}
