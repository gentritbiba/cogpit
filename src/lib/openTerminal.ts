import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"

export interface TerminalTarget {
  /** Absolute project path, when the caller knows it. */
  path?: string
  /** Project directory name, used when no absolute path is available. */
  dirName?: string
  /** Command to run once the terminal is at the directory. */
  command?: string
}

/**
 * Open a native terminal at a project directory, optionally running a command.
 *
 * Returns false without doing anything when the request cannot be honoured:
 * the window would open on the machine running the server, so a remote device
 * would never see it, and the route needs somewhere to open it.
 */
export function openProjectTerminal({ path, dirName, command }: TerminalTarget): boolean {
  if (isRemoteDeviceActive()) {
    console.warn("[open-terminal] unavailable for remote devices")
    return false
  }
  if (!path && !dirName) {
    console.warn("[open-terminal] no project path available")
    return false
  }

  authFetch("/api/open-terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, dirName, ...(command ? { command } : {}) }),
  }).then((res) => {
    if (!res.ok) res.json().then((data) => console.error("[open-terminal]", data.error)).catch(() => {})
  }).catch((error) => console.error("[open-terminal] fetch failed:", error))

  return true
}
