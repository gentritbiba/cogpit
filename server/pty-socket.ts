import type { IncomingMessage } from "node:http"
import type { RawData, WebSocket } from "ws"

import { relayToCore, type CoreSocketRelay } from "./core"
import { agentSignInLaunch } from "./agents/signIn"
import { AGENT_KINDS, type AgentKind } from "../shared/session/agent-descriptors"
import type { AuthorizableSocketManager, SocketAuthorizer } from "./pty-authorization"

/** `crates/core-pty`'s socket, nested by cogpit-core under `/v1/pty`. */
const CORE_PTY_PATH = "/v1/pty/ws"
const AUTHORIZATION_RECHECK_MS = 5_000

/** The `signIn` field of a spawn message, when it names a known agent. */
function signInRequest(value: unknown): { agent: AgentKind; instanceId: string | null } | null {
  if (!value || typeof value !== "object") return null
  const { agent, instanceId } = value as { agent?: unknown; instanceId?: unknown }
  if (typeof agent !== "string" || !(AGENT_KINDS as readonly string[]).includes(agent)) return null
  return { agent: agent as AgentKind, instanceId: typeof instanceId === "string" && instanceId ? instanceId : null }
}

/**
 * A spawn naming an agent's sign-in becomes the plain command the core runs:
 * the server picks the binary, its Windows shim handling and the account's
 * environment, never the client. The environment is the server's to choose,
 * so a client's own `env` is dropped. Null when the spawn was answered here.
 */
function frameForCore(ws: WebSocket, data: RawData): RawData | string | null {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(data.toString()) as Record<string, unknown>
  } catch {
    return data
  }
  if (!message || typeof message !== "object" || message.type !== "spawn") return data
  const { signIn: requested, env, ...spawn } = message
  if (requested === undefined && env === undefined) return data
  const signIn = signInRequest(requested)
  if (!signIn) return JSON.stringify(spawn)
  try {
    const launch = agentSignInLaunch(signIn.agent, signIn.instanceId)
    if (!launch) throw new Error("This agent has no sign-in to run")
    return JSON.stringify({
      ...spawn,
      command: launch.command,
      // cmd.exe takes its `/c` line as one verbatim string.
      args: launch.verbatimArgs ? launch.args.join(" ") : launch.args,
      env: launch.env,
    })
  } catch (err) {
    const id = typeof spawn.id === "string" ? spawn.id : ""
    ws.send(JSON.stringify({ type: "error", id, message: `Failed to spawn PTY: ${err}` }))
    return null
  }
}

/**
 * The terminal panel's socket. Its sessions live in cogpit-core; each
 * connection is relayed there frame for frame, with every frame checked
 * against the connection's authorization in both directions.
 */
export class PtySocketRelay {
  private readonly timers = new Set<ReturnType<typeof setInterval>>()

  /** The shape `PtyAuthorizationController` hands connections to, with the upgrade request bound. */
  socketFor(req: IncomingMessage): AuthorizableSocketManager {
    return { handleConnection: (ws, authorize) => this.relay(ws, req, authorize) }
  }

  private relay(ws: WebSocket, req: IncomingMessage, authorize?: SocketAuthorizer): void {
    let relay: CoreSocketRelay | null = null
    const authorized = (touch: boolean): boolean => {
      if (!authorize) return true
      try {
        if (authorize(touch)) return true
      } catch {
        // Authorization checks fail closed.
      }
      relay?.close(1008, "Session authorization expired")
      return false
    }
    relay = relayToCore(ws, req, CORE_PTY_PATH, {
      toCore: (data) => (authorized(true) ? frameForCore(ws, data) : null),
      toClient: () => authorized(false),
    })
    if (!authorize) return
    const timer = setInterval(() => authorized(false), AUTHORIZATION_RECHECK_MS)
    timer.unref?.()
    this.timers.add(timer)
    ws.once("close", () => {
      clearInterval(timer)
      this.timers.delete(timer)
    })
  }

  cleanup(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
  }
}
