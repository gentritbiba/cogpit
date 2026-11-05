/**
 * The agent check behind setup and Settings: for each CLI a person installs,
 * whether Cogpit can start it, which version, and whether it has an account.
 *
 * Sign-in comes from local evidence only: an account token in the environment,
 * or the CLI's own offline status command. Nothing here calls a model, and a
 * report that does not say plainly is "unknown", never a guess.
 */
import type { AgentCheck, SignInState } from "../../shared/contracts/agentCheck"
import {
  installableDescriptors,
  type InstallableAgentDescriptor,
} from "../../shared/session/agent-descriptors"
import { probeCliVersion, runCli } from "../lib/cliProcess"
import { findLaunchableExecutable } from "./executables"
import { agentSignInTerminalCommand } from "./signIn"

const STATUS_TIMEOUT_MS = 5_000

export interface AgentCheckEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
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
    // The same builder the Sign in button's terminal runs, so the two never disagree.
    signIn: binary ? agentSignInTerminalCommand(descriptor.kind, binary, platform) : null,
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
