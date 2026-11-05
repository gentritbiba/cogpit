/**
 * The agent check behind setup and Settings: for each CLI a person installs,
 * whether Cogpit can start it, which version, and whether it has an account.
 *
 * Sign-in comes from local evidence only: an account token in the environment,
 * or the CLI's own offline status command. Nothing here calls a model, and a
 * report that does not say plainly is "unknown", never a guess.
 */
import type { AgentCheck, SignInState, TerminalCommand } from "../../shared/contracts/agentCheck"
import {
  installableDescriptors,
  type InstallableAgentDescriptor,
} from "../../shared/session/agent-descriptors"
import { probeCliVersion, runCli } from "../lib/cliProcess"
import { findLaunchableExecutable } from "./executables"

const STATUS_TIMEOUT_MS = 5_000

export interface AgentCheckEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

function quote(value: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value
  return platform === "win32" ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The sign-in command as a person would type it. A binary found on PATH is
 * named the short way; any other one (the copy bundled with Cogpit, a custom
 * path) has to be spelled out, or the terminal would not find it.
 */
export function signInCommand(
  descriptor: InstallableAgentDescriptor,
  binary: NonNullable<AgentCheck["binary"]>,
  platform: NodeJS.Platform,
): TerminalCommand {
  const args = [...descriptor.cli.signIn.args]
  const onPath = binary.source === "path" || binary.source === "npm"
  const head = onPath
    ? descriptor.binName
    : `${platform === "win32" ? "& " : ""}${quote(binary.path, platform)}`
  return { executable: binary.path, args, command: [head, ...args].join(" ") }
}

/**
 * Only the descriptor's verdict leaves here: a status report also names the
 * account (email, organization), and that output is read and dropped.
 */
export async function signInState(
  descriptor: InstallableAgentDescriptor,
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<SignInState> {
  const { signIn } = descriptor.cli
  if (signIn.envVars.some((name) => env[name]?.trim())) return true
  if (!signIn.statusArgs) return "unknown"
  return signIn.readStatus(await runCli(binaryPath, signIn.statusArgs, STATUS_TIMEOUT_MS))
}

async function checkAgent(
  descriptor: InstallableAgentDescriptor,
  { platform = process.platform, env = process.env }: AgentCheckEnvironment,
): Promise<AgentCheck> {
  const found = await findLaunchableExecutable(descriptor.kind)
  const binary = found.status === "found" ? { path: found.path, source: found.source } : null
  const [version, signedIn] = binary
    ? await Promise.all([
        probeCliVersion(binary.path, descriptor.cli.versionArgs),
        signInState(descriptor, binary.path, env),
      ])
    : [null, "unknown" as const]
  return {
    kind: descriptor.kind,
    displayName: descriptor.displayName,
    binary,
    unlaunchableChoice: found.status === "unlaunchable-choice" ? { path: found.path } : null,
    version,
    signedIn,
    install: { page: descriptor.cli.install.page, command: descriptor.cli.install.command(platform) },
    signIn: binary ? signInCommand(descriptor, binary, platform) : null,
  }
}

/** Every installable agent, probed fresh so a CLI installed a moment ago shows up. */
export function checkAgents(environment: AgentCheckEnvironment = {}): Promise<AgentCheck[]> {
  return Promise.all(installableDescriptors().map((descriptor) => checkAgent(descriptor, environment)))
}

let inFlight: Promise<AgentCheck[]> | null = null

/**
 * The check every client asks for. Callers arriving while one runs share it;
 * a request after it ends starts a new one, so "Check again" sees an install
 * made a moment ago.
 */
export function sharedAgentCheck(): Promise<AgentCheck[]> {
  if (!inFlight) inFlight = checkAgents().finally(() => { inFlight = null })
  return inFlight
}
