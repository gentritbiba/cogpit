/**
 * Running an agent CLI as a one-shot child process, and reading its version.
 *
 * Version probing used to exist three times over with three different regexes,
 * which meant the number the update banner showed and the number the hot-swap
 * detector compared against could disagree for the same binary. There is one
 * probe now, and `shared/versions.extractVersion` is the only parser.
 */
import { spawn } from "node:child_process"
import { extractVersion } from "../../shared/versions"
import { resolveAgentCommand } from "./binaryResolver"

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** Enough output to diagnose a failure; package managers emit far more. */
export const CLI_OUTPUT_MAX_CHARS = 10_000

export interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run `executable args`, capturing a bounded amount of output. Never rejects:
 * a spawn failure is reported as `code: null`, which every caller here treats
 * the same way as a non-zero exit.
 */
export function runCli(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const resolved = resolveAgentCommand(executable, [...args])
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...resolved.spawnOptions,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    // npm's progress output is unbounded; only the tail-end matters and the
    // response truncates anyway, so stop accumulating well before that.
    const append = (buffer: string, chunk: Buffer): string =>
      buffer.length >= CLI_OUTPUT_MAX_CHARS ? buffer : buffer + chunk.toString()

    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * Version of the CLI at `command`, or null when it cannot be determined.
 * Callers treat null as "no evidence", never as "not installed": a binary that
 * exists but fails to report a version is a broken install, not a missing one.
 *
 * stderr is read alongside stdout because some CLIs print their banner there.
 */
export async function probeCliVersion(
  command: string,
  versionArgs: readonly string[],
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const probe = await runCli(command, versionArgs, timeoutMs)
  return extractVersion(`${probe.stdout}\n${probe.stderr}`)
}
