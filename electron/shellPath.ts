import { execFileSync, spawn } from "node:child_process"

/** How long the login shell gets to report PATH before Cogpit starts without it. */
export const SHELL_PATH_TIMEOUT_MS = 3_000

const START = "<cogpit-path>"
const END = "</cogpit-path>"
/** `wait` keeps the shell, and so the parent links to anything it started, alive until the probe ends. */
const COMMAND = `printf '%s' "${START}$PATH${END}"; wait`

/**
 * The user's PATH as their login shell sets it, or null. GUI apps don't
 * inherit it on macOS and Linux, and without it the agent CLIs are not found.
 * Windows apps do inherit it, so there is nothing to ask.
 *
 * The PATH is read between markers and taken as soon as it arrives, so output
 * held open by a job the startup files left running cannot hold it back. A
 * startup file that waits for input or hangs must not hold the launch hostage,
 * nor leave processes behind: when the PATH arrives, the timeout passes or
 * `signal` aborts, everything the shell started is killed.
 */
export function loginShellPath(
  shell: string,
  { timeoutMs = SHELL_PATH_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (process.platform === "win32" || signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", COMMAND], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    let output = ""
    let settled = false

    const finish = (path: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abandon)
      if (child.pid) killProcessTree(child.pid)
      resolve(path)
    }
    const abandon = () => finish(null)
    const timer = setTimeout(abandon, timeoutMs)
    signal?.addEventListener("abort", abandon, { once: true })

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk
      const end = output.indexOf(END)
      if (end === -1) return
      const start = output.lastIndexOf(START, end)
      finish(start === -1 ? null : output.slice(start + START.length, end) || null)
    })
    child.once("error", abandon)
    child.once("close", abandon)
  })
}

/**
 * Kill the process group `root` leads (the probe runs detached, so it leads its
 * own) and the group of every process still descended from it. A shell with job
 * control on gives each job a group of its own, which killing only the shell's
 * group would miss. The tree is read before anything is killed, while the parent
 * links still hold. Every group found belongs to the probe's own session or one
 * a descendant created, so nothing else is touched. SIGKILL, because interactive
 * shells ignore SIGTERM.
 */
function killProcessTree(root: number): void {
  const groups = new Set([root])
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" })
      .trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
    const tree = new Set([root])
    for (let grew = true; grew;) {
      grew = false
      for (const [pid, ppid, pgid] of rows) {
        if (!tree.has(pid) && tree.has(ppid)) {
          tree.add(pid)
          groups.add(pgid)
          grew = true
        }
      }
    }
  } catch {
    // Without ps, the shell's own group is all that can be reached.
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}
