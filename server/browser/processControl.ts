/**
 * The two places daemon control touches the OS directly. Windows has no `ps`
 * and no process groups: a plain terminate leaves the daemon's Chromium
 * running with nothing left to close it, so the whole tree goes at once.
 */
export type ProcessRunner = (file: string, args: string[]) => string

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
