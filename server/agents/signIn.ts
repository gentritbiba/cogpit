import { descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { spawnedExecutableFor } from "./executables"
import { instanceAuthEnvironment, providerInstance } from "./instanceConfigurations"
import { AgentRuntimeError } from "./runtimeTypes"

/** An agent's own sign-in, ready to run in a terminal on this server. */
export interface SignInLaunch {
  /** A Windows batch shim is already wrapped in `cmd.exe`, the way the runtimes launch it. */
  command: string
  args: string[]
  /** `cmd.exe` must get its command line as one verbatim string, not re-quoted arguments. */
  verbatimArgs: boolean
  /** Layered over the server's environment: an account instance's home and config folders. */
  env: Record<string, string>
}

interface SignInTarget {
  executable: string
  args: readonly string[]
  env: Record<string, string>
}

function targetFor(kind: AgentKind, instance: ProviderInstance | null): SignInTarget | null {
  const { binName, cli } = descriptorFor(kind)
  if (!cli.signIn) return null
  if (instance && instance.agent !== kind) {
    throw new AgentRuntimeError(409, "INSTANCE_MISMATCH", "This account belongs to a different agent")
  }
  return {
    // The binary this agent's sessions run, which may be one no shell finds by
    // name: Cogpit's bundled copy, or the executable an instance was given.
    executable: instance?.executable || spawnedExecutableFor(kind)?.path || binName,
    args: cli.signIn.args,
    env: instance ? instanceAuthEnvironment(instance) : {},
  }
}

/**
 * How to run an agent's sign-in so the login lands where its sessions look:
 * with the binary Cogpit spawns, and for a provider-account instance, that
 * instance's executable and home. Null for an agent with no sign-in of its own.
 */
export function agentSignInLaunch(kind: AgentKind, instanceId?: string | null): SignInLaunch | null {
  const target = targetFor(kind, instanceId ? providerInstance(instanceId) : null)
  if (!target) return null
  const resolved = resolveAgentCommand(target.executable, [...target.args], { env: { ...process.env, ...target.env } })
  return {
    command: resolved.command,
    args: resolved.args,
    verbatimArgs: resolved.spawnOptions.windowsVerbatimArguments === true,
    env: target.env,
  }
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const bare = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : quote(value))

/**
 * One line to paste into a terminal on this server, PowerShell on Windows.
 * `executable` is quoted unless it is a placeholder for a person to fill in.
 */
function commandLine(target: SignInTarget, { placeholder = false } = {}): string {
  const executable = placeholder ? target.executable : quote(target.executable)
  const entries = Object.entries(target.env)
  if (process.platform === "win32") {
    return [...entries.map(([key, value]) => `$env:${key}=${quote(value)}`), [`&`, executable, ...target.args].join(" ")].join("; ")
  }
  const prefix = entries.map(([key, value]) => `${key}=${quote(value)}`)
  return [...(prefix.length > 0 ? ["env", ...prefix] : []), placeholder ? executable : bare(target.executable), ...target.args].join(" ")
}

/** The sign-in as a command to copy, for where Cogpit cannot open a terminal. */
export function agentSignInCommand(kind: AgentKind, instanceId?: string | null): string | null {
  const target = targetFor(kind, instanceId ? providerInstance(instanceId) : null)
  return target && commandLine(target)
}

/**
 * What an administrator runs to sign a provider-account instance in. An agent
 * Cogpit is told how to launch has no sign-in of its own, so its command is
 * left for the administrator to fill in.
 */
export function providerSetupCommand(instance: ProviderInstance): string {
  const target = targetFor(instance.agent, instance)
  return target
    ? commandLine(target)
    : commandLine({ executable: "<provider-login-command>", args: [], env: instanceAuthEnvironment(instance) }, { placeholder: true })
}
