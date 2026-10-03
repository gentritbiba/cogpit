import { readFileSync } from "node:fs"

/**
 * The places daemon control touches the OS directly. Windows has no `ps`
 * and no process groups: a plain terminate leaves the daemon's Chromium
 * running with nothing left to close it, so the whole tree goes at once.
 */
export type ProcessRunner = (file: string, args: string[]) => string

/** An agent-browser daemon in the process table, with the browser and socket dir its environment names. */
export interface DaemonProcess {
  pid: number
  name: string
  socketDir: string
  ageMs: number
}

const DAEMON_SCRIPT = /agent-browser.*daemon\.js/
const DAEMON_ENV = ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_SOCKET_DIR"] as const

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds. */
export function elapsedMs(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!match) return null
  const [, days = "0", hours = "0", minutes, seconds] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000
}

/**
 * The two variables a daemon was started with, which is what ties it to a
 * browser. Linux reads them from /proc; elsewhere `ps` prints them after the
 * command, space separated, so a value runs to the next NAME= word.
 */
function daemonEnvironment(pid: number, platform: NodeJS.Platform, run: ProcessRunner): Map<string, string> {
  const env = new Map<string, string>()
  if (platform === "linux") {
    try {
      for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
        const at = entry.indexOf("=")
        const key = entry.slice(0, at)
        if ((DAEMON_ENV as readonly string[]).includes(key)) env.set(key, entry.slice(at + 1))
      }
      return env
    } catch {
      // Gone already, or /proc is not readable here: ask ps.
    }
  }
  let line = ""
  try {
    line = run("ps", ["eww", "-o", "command=", "-p", String(pid)]).trimEnd()
  } catch {
    return env
  }
  for (const key of DAEMON_ENV) {
    const match = new RegExp(`(?:^| )${key}=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`).exec(line)
    if (match) env.set(key, match[1])
  }
  return env
}

/**
 * Every agent-browser daemon running as this user. None on Windows, where a
 * daemon listens on a port hashed from its browser's name and a second one
 * for the same browser cannot start.
 */
export function listDaemonProcesses(platform: NodeJS.Platform, run: ProcessRunner): DaemonProcess[] {
  if (platform === "win32") return []
  let table: string
  try {
    table = run("ps", ["-A", "-o", "pid=,etime=,command="])
  } catch {
    return []
  }
  return table.split("\n").flatMap((line): DaemonProcess[] => {
    const row = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!row || !DAEMON_SCRIPT.test(row[3])) return []
    const pid = Number(row[1])
    const ageMs = elapsedMs(row[2])
    const env = daemonEnvironment(pid, platform, run)
    const name = env.get("AGENT_BROWSER_SESSION")
    const socketDir = env.get("AGENT_BROWSER_SOCKET_DIR")
    return name && socketDir && ageMs !== null ? [{ pid, name, socketDir, ageMs }] : []
  })
}

export function processCommandLine(pid: number, platform: NodeJS.Platform, run: ProcessRunner): string {
  try {
    return platform === "win32"
      ? run("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`])
      : run("ps", ["-o", "command=", "-p", String(pid)])
  } catch {
    return ""
  }
}

export function terminateProcess(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  run: ProcessRunner,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): void {
  if (platform === "win32") run("taskkill", ["/pid", String(pid), "/t", "/f"])
  else kill(pid, signal)
}
