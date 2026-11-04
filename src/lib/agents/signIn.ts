import { useSyncExternalStore } from "react"

import { descriptorFor, type AgentKind } from "../../../shared/session/agent-descriptors"
import { agentSignInCommand } from "../../../shared/session/agentFailures"
import { agentExecutable } from "./availability"

/**
 * Signing an agent in means running its own login in a terminal, with the
 * binary Cogpit spawns — which may be the SDK's bundled copy that no shell can
 * find by name. The terminal panel registers itself as the runner when it can
 * open one here; without it, callers show the command to copy instead.
 */

export interface SignInLaunch {
  kind: AgentKind
  /** Window title for the terminal tab. */
  name: string
  command: string
  args: readonly string[]
}

type Runner = (launch: SignInLaunch) => void

let runner: Runner | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerSignInRunner(next: Runner): () => void {
  runner = next
  notify()
  return () => {
    if (runner !== next) return
    runner = null
    notify()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether a terminal panel here can run the sign-in. */
export function useCanRunSignIn(): boolean {
  return useSyncExternalStore(subscribe, () => runner !== null, () => false)
}

/** The command to show for copying, spelled with the binary Cogpit actually runs. */
export function signInCommandFor(kind: AgentKind): string | null {
  return agentSignInCommand(kind, agentExecutable(kind))
}

/**
 * Open a terminal running the agent's sign-in. Returns false when there is no
 * terminal to open it in, or the agent has no sign-in of its own.
 */
export function startAgentSignIn(kind: AgentKind): boolean {
  const { binName, displayName, cli } = descriptorFor(kind)
  if (!runner || !cli.signIn) return false
  runner({ kind, name: `Sign in to ${displayName}`, command: agentExecutable(kind) ?? binName, args: cli.signIn.args })
  return true
}
