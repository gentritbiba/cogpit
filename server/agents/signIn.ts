import { descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import type { TerminalCommand } from "../../shared/contracts/agentCheck"
import type { SpawnedExecutable } from "./executables"
import { instanceAuthEnvironment, providerInstance } from "./instanceConfigurations"
import { accountBinary, agentTerminalLaunch, type AgentTerminalLaunch } from "./terminalLaunch"

interface SignInTarget {
  binName: string
  /** Null when nothing was found; the CLI's name is the best guess left. */
  binary: SpawnedExecutable | null
  args: readonly string[]
  env: Record<string, string>
}

function targetFor(kind: AgentKind, instance: ProviderInstance | null, found?: SpawnedExecutable): SignInTarget | null {
  const { binName, cli } = descriptorFor(kind)
  if (!cli.signIn) return null
  return {
    binName,
    binary: accountBinary(kind, instance, found),
    args: cli.signIn.args,
    env: instance ? instanceAuthEnvironment(instance) : {},
  }
}

/**
 * How to run an agent's sign-in so the login lands where its sessions look:
 * with the binary Cogpit spawns, and for a provider-account instance, that
 * instance's executable and home. Null for an agent with no sign-in of its own.
 */
export function agentSignInLaunch(kind: AgentKind, instanceId?: string | null): AgentTerminalLaunch | null {
  const target = targetFor(kind, instanceId ? providerInstance(instanceId) : null)
  return target && agentTerminalLaunch(target.binary, target.binName, [...target.args], target.env)
}

/** A POSIX shell single-quoted word: an apostrophe closes, escapes and reopens. */
const posixQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
/** A PowerShell single-quoted string: an apostrophe is doubled. */
const powershellQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
const bare = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : posixQuote(value))

/**
 * One line to paste into a terminal on a server running `platform`,
 * PowerShell on Windows. A binary found on PATH is named the short way; any
 * other one (the copy bundled with Cogpit, a custom path) has to be spelled
 * out, or the terminal would not find it.
 */
function commandLine(target: SignInTarget, platform: NodeJS.Platform = process.platform): string {
  const { binary } = target
  const byName = !binary || binary.source === "path" || binary.source === "npm"
  const entries = Object.entries(target.env)
  if (platform === "win32") {
    const head = byName ? target.binName : `& ${powershellQuote(binary.path)}`
    return [...entries.map(([key, value]) => `$env:${key}=${powershellQuote(value)}`), [head, ...target.args].join(" ")].join("; ")
  }
  const prefix = entries.map(([key, value]) => `${key}=${posixQuote(value)}`)
  return [...(prefix.length > 0 ? ["env", ...prefix] : []), byName ? target.binName : bare(binary.path), ...target.args].join(" ")
}

/** The sign-in as a command to copy, for where Cogpit cannot open a terminal. */
export function agentSignInCommand(kind: AgentKind, instanceId?: string | null): string | null {
  const target = targetFor(kind, instanceId ? providerInstance(instanceId) : null)
  return target && commandLine(target)
}

/**
 * The default account's sign-in for a binary the agent check found: the argv
 * the Sign in button runs and the same command to copy, so the check and the
 * terminal can never disagree.
 */
export function agentSignInTerminalCommand(
  kind: AgentKind,
  binary: SpawnedExecutable,
  platform: NodeJS.Platform,
): TerminalCommand | null {
  const target = targetFor(kind, null, binary)
  return target && { executable: binary.path, args: [...target.args], command: commandLine(target, platform) }
}

/**
 * What an administrator runs to sign a provider-account instance in. An agent
 * Cogpit is told how to launch has no sign-in of its own, so its command is
 * left for the administrator to fill in.
 */
export function providerSetupCommand(instance: ProviderInstance): string {
  const target = targetFor(instance.agent, instance)
  if (target) return commandLine(target)
  const env = Object.entries(instanceAuthEnvironment(instance))
  return process.platform === "win32"
    ? [...env.map(([key, value]) => `$env:${key}=${powershellQuote(value)}`), "& <provider-login-command>"].join("; ")
    : ["env", ...env.map(([key, value]) => `${key}=${posixQuote(value)}`), "<provider-login-command>"].join(" ")
}
