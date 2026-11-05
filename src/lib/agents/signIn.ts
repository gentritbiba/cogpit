import { useEffect, useState, useSyncExternalStore } from "react"

import { descriptorFor, type AgentKind } from "../../../shared/session/agent-descriptors"
import { splitInstanceDirName } from "../../../shared/session/instances"
import { authFetch } from "@/lib/auth"
import { deviceScopedKey } from "@/lib/device"
import { agentAvailability, useAgentAvailability } from "./availability"

/**
 * Signing an agent in means running its own login in a terminal, as the
 * account a session runs under: the default one, or a provider-account
 * instance with its own executable and home. The server works out the binary
 * and environment from the agent and instance, so this side only names them.
 * The terminal panel registers itself as the runner when it can open a
 * terminal here; without it, callers show the command to copy instead.
 */

export interface SignInTarget {
  kind: AgentKind
  /** The provider-account instance a session runs under; null for the default account. */
  instanceId: string | null
}

/** Whose sign-in a session needs: its agent, and the account instance its dirName names. */
export function signInTargetFor(kind: AgentKind, dirName?: string | null): SignInTarget {
  const { instanceId } = splitInstanceDirName(dirName)
  return { kind, instanceId: instanceId === "default" ? null : instanceId }
}

export interface SignInLaunch {
  target: SignInTarget
  /** Window title for the terminal tab. */
  name: string
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

/**
 * Open a terminal running the agent's sign-in for the target's account.
 * Returns false when there is no terminal to open it in, or the agent has no
 * sign-in of its own.
 */
export function startAgentSignIn(target: SignInTarget): boolean {
  const { displayName, cli } = descriptorFor(target.kind)
  if (!runner || !cli.signIn) return false
  runner({ target, name: `Sign in to ${displayName}` })
  return true
}

interface InstanceListing {
  id: string
  /** Only an administrator is shown how to sign an instance in. */
  setupCommand?: string
}

/**
 * The sign-in as a command to copy, as the active machine's server spells it
 * for the target's account; null until it answers, or when it will not say.
 */
export function useSignInCommand(target: SignInTarget): string | null {
  const availability = useAgentAvailability()
  const [instanceCommand, setInstanceCommand] = useState<{ key: string; command: string | null } | null>(null)
  const key = `${deviceScopedKey("agent-sign-in")}::${target.instanceId ?? ""}`

  useEffect(() => {
    if (!target.instanceId) return
    let current = true
    authFetch("/api/provider-instances")
      .then((response) => (response.ok ? response.json() as Promise<{ instances?: InstanceListing[] }> : null))
      .then((body) => {
        const command = body?.instances?.find((instance) => instance.id === target.instanceId)?.setupCommand ?? null
        if (current) setInstanceCommand({ key, command })
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [key, target.instanceId])

  if (!target.instanceId) return agentAvailability(availability, target.kind)?.signInCommand ?? null
  return instanceCommand?.key === key ? instanceCommand.command : null
}
