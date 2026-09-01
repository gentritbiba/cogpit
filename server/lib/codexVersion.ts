/**
 * Version probes for the `codex` CLI.
 *
 * The app-server child is long-lived, but the binary behind it is not: a
 * `bun install -g @openai/codex@latest` swaps the vendored executables under
 * the running process. The old CLI then spawns the *new* code-mode host and
 * every shell command comes back as an IPC decode error, so the client needs a
 * way to notice the swap and reconnect.
 */
import { execFile } from "node:child_process"
import { resolveAgentCommand } from "./binaryResolver"

const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** `cogpit/0.152.0 (Mac OS 26.2.0; arm64) …` — the version is Codex's, not ours. */
const USER_AGENT_VERSION = /^[^/\s]+\/(\d+\.\d+\.\d+[\w.-]*)/

/** `codex-cli 0.152.0` */
const CLI_VERSION = /(\d+\.\d+\.\d+[\w.-]*)/

/** Codex version an app-server reported in its `initialize` result. */
export function parseUserAgentVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") return null
  return USER_AGENT_VERSION.exec(userAgent)?.[1] ?? null
}

/** Codex version from `codex --version` output. */
export function parseCliVersion(output: string): string | null {
  return CLI_VERSION.exec(output)?.[1] ?? null
}

/**
 * Version of the `codex` currently on disk, or null when it cannot be
 * determined. Callers treat null as "no evidence of a change".
 */
export function readInstalledCodexVersion(
  command: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const cli = resolveAgentCommand(command, ["--version"])
  return new Promise((resolve) => {
    execFile(
      cli.command,
      cli.args,
      { timeout: timeoutMs, ...cli.spawnOptions },
      (error, stdout) => {
        resolve(error ? null : parseCliVersion(stdout))
      },
    )
  })
}
