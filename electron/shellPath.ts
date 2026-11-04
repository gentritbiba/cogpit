import { execFile } from "node:child_process"

/** How long the login shell gets to report PATH before Cogpit starts without it. */
export const SHELL_PATH_TIMEOUT_MS = 3_000

/**
 * The user's PATH as their login shell sets it, or null. GUI apps don't
 * inherit it, and without it the agent CLIs are not found.
 *
 * A startup file that waits for input (an update prompt, a conda hook) must not
 * hold the launch hostage: stdin is closed, and the shell is killed after the
 * timeout with SIGKILL because interactive shells ignore SIGTERM.
 */
export function loginShellPath(shell: string, timeoutMs = SHELL_PATH_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ["-ilc", 'echo -n "$PATH"'],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => resolve(error || !stdout ? null : stdout),
    )
    child.stdin?.end()
  })
}
