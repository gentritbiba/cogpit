import type { CommandIntent, CommandReceipt } from "../../shared/contracts/orchestration"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { resolveSessionAgent } from "../agents/runtimes"
import { attachCommandAuthority } from "../lib/durableSend"
import { readReplyTo } from "../lib/sessionResult"
import { queueContext } from "../lib/sessionQueue"
import { waitForSessions } from "../lib/sessionWait"
import { localHost } from "../sessionHosts/localHost"
import { slackApi } from "./api"
import { SlackService, successorOf } from "./service"
import { SocketModeClient } from "./socket"
import { SlackStore } from "./store"

const TURN_LIMIT_MS = 6 * 3600_000
const SETTLED = new Set(["completed", "failed", "cancelled"])

let service: SlackService | null = null

/**
 * A restart (or a busy agent) holds queued work for the user to review. A
 * Slack message was already acknowledged as received, so release just this
 * one under its successor id and leave the rest of the queue as it is.
 * Promoting to the same successor twice is a no-op, so a crash before the
 * inbox records the new id is recovered by following it.
 */
async function releaseHeld(sessionId: string, commandId: string, intent: CommandIntent): Promise<string> {
  const { dispatcher, conversation, scope, runtime } = await queueContext(sessionId)
  attachCommandAuthority(scope, conversation.id, runtime)
  const next = successorOf(commandId)
  dispatcher.store.promote(scope, commandId, next, intent)
  void dispatcher.tick()
  return next
}

/** The receipt now carrying a message: an id that was released under a successor is followed to it. */
async function currentReceipt(commandId: string): Promise<CommandReceipt | null> {
  let receipt = await localHost.receipt!(commandId)
  while (receipt?.state === "cancelled") {
    const successor = await localHost.receipt!(successorOf(receipt.id))
    if (!successor) break
    receipt = successor
  }
  return receipt
}

/** The server's Slack links, wired to this machine's sessions. */
export function slackService(): SlackService {
  service ??= new SlackService({
    store: new SlackStore(),
    api: (token) => slackApi(token),
    connect: (bot, onEvent) => new SocketModeClient({ appApi: slackApi(bot.appToken), onEvent, log: (message) => console.log(`[slack] ${bot.name}: ${message}`) }),
    async deliver(sessionId, text, commandId) {
      const existing = await currentReceipt(commandId)
      if (existing?.state === "held") return { commandId: await releaseHeld(sessionId, existing.id, existing.intent) }
      if (existing) return { commandId: existing.id, uncertain: existing.state === "unknown" }
      const { kind } = await resolveSessionAgent(sessionId)
      // Steering joins a running turn and starts one when idle; a provider that cannot steer queues instead.
      const intent = descriptorFor(kind).capabilities.midTurnSteering ? "steer" : "queue"
      await localHost.send(sessionId, text, { commandId, intent })
      return { commandId }
    },
    sessionExists: (sessionId) => localHost.has(sessionId),
    async turnEnded(sessionId, commandId, header, signal) {
      const deadline = Date.now() + TURN_LIMIT_MS
      for (;;) {
        const receipt = await localHost.receipt!(commandId, undefined, 60_000)
        if (!receipt || signal.aborted || Date.now() > deadline) return null
        if (receipt.state === "completed") break
        if (receipt.state === "held") return { held: true }
        if (receipt.state === "unknown") return { uncertain: true }
        if (SETTLED.has(receipt.state)) return null
      }
      const { timedOut } = await waitForSessions([sessionId], { mode: "all", timeoutMs: Math.max(0, deadline - Date.now()), signal, pollMs: 3000 })
      if (timedOut) return null
      return { reply: await readReplyTo(sessionId, header) }
    },
  })
  return service
}

export function startSlack(): void {
  slackService().start().catch((error: unknown) => console.error("[slack] start failed:", error))
}

export async function stopSlack(): Promise<void> {
  const current = service
  service = null
  await current?.stop()
}
