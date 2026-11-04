import { spawn } from "node:child_process"

/** How long the login shell gets to report PATH before Cogpit starts without it. */
export const SHELL_PATH_TIMEOUT_MS = 3_000

/**
 * The user's PATH as their login shell sets it, or null. GUI apps don't
 * inherit it on macOS and Linux, and without it the agent CLIs are not found.
 * Windows apps do inherit it, so there is nothing to ask.
 *
 * A startup file that waits for input or hangs (an update prompt, a conda hook)
 * must not hold the launch hostage, and must not leave processes behind. The
 * shell runs in its own process group with stdin closed, and the whole group is
 * killed once the shell exits, the timeout passes or `signal` aborts. SIGKILL,
 * because interactive shells ignore SIGTERM.
 */
export function loginShellPath(
  shell: string,
  { timeoutMs = SHELL_PATH_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (process.platform === "win32" || signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", 'echo -n "$PATH"'], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    let stdout = ""
    let settled = false

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        // The group is already empty.
      }
    }
    const finish = (path: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abandon)
      killGroup()
      resolve(path)
    }
    const abandon = () => finish(null)
    const timer = setTimeout(abandon, timeoutMs)
    signal?.addEventListener("abort", abandon, { once: true })

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.once("error", abandon)
    // Anything the startup file left running still holds the pipe open, so
    // the output is only complete once the rest of the group is gone too.
    child.once("exit", killGroup)
    child.once("close", (code) => finish(code === 0 && stdout ? stdout : null))
  })
}
