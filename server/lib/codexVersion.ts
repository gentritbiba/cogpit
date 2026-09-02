/**
 * Version reconciliation for the `codex` app-server.
 *
 * The app-server child is long-lived, but the binary behind it is not: a
 * `bun install -g @openai/codex@latest` swaps the vendored executables under
 * the running process. The old CLI then spawns the *new* code-mode host and
 * every shell command comes back as an IPC decode error, so the client needs a
 * way to notice the swap and reconnect.
 *
 * Both sides of that comparison — the version the running app-server announced
 * and the version on disk — go through `shared/versions.extractVersion`, so a
 * parser difference can never make an unchanged binary look upgraded.
 */
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { extractVersion } from "../../shared/versions"
import { probeCliVersion } from "./cliProcess"

/** `cogpit/0.152.0 (Mac OS 26.2.0; arm64) …` — the version is Codex's, not ours. */
const USER_AGENT_PREFIX = /^[^/\s]+\/(.*)$/

/** Codex version an app-server reported in its `initialize` result. */
export function parseUserAgentVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") return null
  const afterProduct = USER_AGENT_PREFIX.exec(userAgent)?.[1]
  return afterProduct === undefined ? null : extractVersion(afterProduct)
}

/**
 * Version of the `codex` currently on disk, or null when it cannot be
 * determined. Takes the command the app-server was actually started with,
 * which may be a configured path rather than the name on PATH.
 */
export function readInstalledCodexVersion(
  command: string,
  timeoutMs?: number,
): Promise<string | null> {
  return probeCliVersion(command, descriptorFor("codex").cli.versionArgs, timeoutMs)
}
