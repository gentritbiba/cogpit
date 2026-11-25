import type { IncomingMessage } from "node:http"
import type { RawData, WebSocket } from "ws"

import { relayToCore, type CoreSocketRelay } from "./core"
import { agentSignInLaunch } from "./agents/signIn"
import { agentCodeModeLaunch, codeModeRequest } from "./agents/codeMode"
import type { AgentTerminalLaunch } from "./agents/terminalLaunch"
import { AGENT_KINDS, type AgentKind } from "../shared/session/agent-descriptors"
import type { AuthorizableSocketManager, SocketAuthorizer } from "./pty-authorization"
import { editionOwnsSignIn } from "./edition"

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

/** The agent launch a spawn asks for, with the session it runs; null for a plain terminal or an unreadable sign-in. */
function agentLaunchFor(signIn: unknown, codeMode: unknown): { launch: AgentTerminalLaunch; sessionId?: string } | null {
  if (signIn !== undefined && codeMode !== undefined) throw new Error("A terminal runs a sign-in or a Code Mode session, not both")
  if (signIn !== undefined) {
    const request = signInRequest(signIn)
    if (!request) return null
    const launch = agentSignInLaunch(request.agent, request.instanceId)
    if (!launch) throw new Error("This agent has no sign-in to run")
    return { launch }
  }
  if (codeMode === undefined) return null
  // An edition that signs accounts in decides who owns a new session and
  // accounts for its prompts; a terminal launch would go around both.
  if (editionOwnsSignIn()) throw new Error("Code Mode sessions are not available on a server that signs in accounts")
  const request = codeModeRequest(codeMode)
  if (!request) throw new Error("This server cannot start that Code Mode session")
  return { launch: agentCodeModeLaunch(request), sessionId: request.sessionId }
}

/** `metadata` naming only the session the server itself launched, if any: a client cannot tie a terminal to a session. */
function metadataFor(metadata: unknown, sessionId: string | undefined): Record<string, unknown> {
  const own: Record<string, unknown> = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : { type: "terminal" }
  delete own.sessionId
  return sessionId ? { ...own, sessionId } : own
}

function claimsSession(metadata: unknown): boolean {
  return Boolean(metadata) && typeof metadata === "object" && "sessionId" in (metadata as object)
}

/**
 * A spawn naming an agent's sign-in or a Code Mode session becomes the plain
 * command the core runs: the server picks the binary, its Windows shim
 * handling and the account's environment, never the client. The environment
 * is the server's to choose, so a client's own `env` is dropped. Null when the
 * spawn was answered here.
 */
function frameForCore(ws: WebSocket, data: RawData): RawData | string | null {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(data.toString()) as Record<string, unknown>
  } catch {
    return data
  }
  if (!message || typeof message !== "object" || message.type !== "spawn") return data
  const { signIn, codeMode, env, metadata, ...spawn } = message
  if (signIn === undefined && codeMode === undefined && env === undefined && !claimsSession(metadata)) return data
  try {
    const agent = agentLaunchFor(signIn, codeMode)
    const plain = metadata === undefined && !agent?.sessionId ? spawn : { ...spawn, metadata: metadataFor(metadata, agent?.sessionId) }
    if (!agent) return JSON.stringify(plain)
    const { launch } = agent
    return JSON.stringify({
      ...plain,
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
