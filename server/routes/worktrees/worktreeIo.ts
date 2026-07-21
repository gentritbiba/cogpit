import { execFile } from "node:child_process"
import { promisify } from "node:util"

export const WORKTREE_COMMAND_TIMEOUT_MS = 15_000
export const WORKTREE_NETWORK_TIMEOUT_MS = 120_000
export const WORKTREE_COMMAND_MAX_BUFFER = 4 * 1024 * 1024
export const WORKTREE_SCAN_CONCURRENCY = 4
export const SESSION_HEADER_CONCURRENCY = 8

const execFileAsync = promisify(execFile)

const NONINTERACTIVE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GCM_INTERACTIVE: "Never",
  GH_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
}

interface WorktreeCommandOptions {
  cwd: string
  timeoutMs?: number
}

/** Run a bounded, non-interactive subprocess without blocking the event loop. */
export async function runWorktreeCommand(
  file: string,
  args: readonly string[],
  { cwd, timeoutMs = WORKTREE_COMMAND_TIMEOUT_MS }: WorktreeCommandOptions,
): Promise<string> {
  const result = await execFileAsync(file, [...args], {
    cwd,
    encoding: "utf-8",
    env: NONINTERACTIVE_ENV,
    maxBuffer: WORKTREE_COMMAND_MAX_BUFFER,
    timeout: timeoutMs,
    windowsHide: true,
  })

  // Node's execFile defines a custom promisifier that returns { stdout, stderr }.
  // Test doubles and compatible runtimes may expose the standard single-value form.
  return typeof result === "string" ? result : result.stdout
}

/** Map values with deterministic output ordering and a hard concurrency ceiling. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer")
  }

  const results = new Array<R>(values.length)
  let nextIndex = 0

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(values[index], index)
      }
    },
  )

  await Promise.all(workers)
  return results
}
