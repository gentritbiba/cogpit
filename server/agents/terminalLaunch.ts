import type { ProviderInstance } from "../../shared/contracts/orchestration"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { spawnedExecutableFor, type SpawnedExecutable } from "./executables"
import { AgentRuntimeError } from "./runtimeTypes"

/** An agent CLI to run in the terminal panel, ready for cogpit-core to spawn. */
export interface AgentTerminalLaunch {
  /** A Windows batch shim is already wrapped in `cmd.exe`, the way the runtimes launch it. */
  command: string
  args: string[]
  /** `cmd.exe` must get its command line as one verbatim string, not re-quoted arguments. */
  verbatimArgs: boolean
  /** Layered over the server's environment. */
  env: Record<string, string>
}

/**
 * The binary an account's sessions run, which may be one no shell finds by
 * name: Cogpit's bundled copy, or the executable an instance was given. Null
 * when nothing was found.
 */
export function accountBinary(kind: AgentKind, instance: ProviderInstance | null, found?: SpawnedExecutable): SpawnedExecutable | null {
  if (instance && instance.agent !== kind) {
    throw new AgentRuntimeError(409, "INSTANCE_MISMATCH", "This account belongs to a different agent")
  }
  return instance?.executable ? { path: instance.executable, source: "custom" } : (found ?? spawnedExecutableFor(kind))
}

/** `args` for `binary`, or for the CLI's name when nothing was found, as cogpit-core spawns them. */
export function agentTerminalLaunch(
  binary: SpawnedExecutable | null,
  binName: string,
  args: string[],
  env: Record<string, string>,
): AgentTerminalLaunch {
  const resolved = resolveAgentCommand(binary?.path ?? binName, args, { env: { ...process.env, ...env } })
  return {
    command: resolved.command,
    args: resolved.args,
    verbatimArgs: resolved.spawnOptions.windowsVerbatimArguments === true,
    env,
  }
}
