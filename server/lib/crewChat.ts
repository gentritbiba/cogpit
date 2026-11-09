import type { IncomingMessage } from "node:http"
import { CREW_CHAT_MAX_LENGTH, crewChatHandles, crewChatMentions, formatCrewChatDelivery, type CrewChatAuthor, type CrewChatDelivery, type CrewChatMember, type CrewChatMessage, type CrewChatPage } from "../../shared/contracts/crewChat"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { accessLevelOf, editionModule, getRequestPrincipal } from "../edition"
import { beforeOrchestrationClose, orchestrationStore } from "../orchestration/storage"
import { fingerprint, OrchestrationError } from "../orchestration/store"
import { DeviceRequestError } from "../hub/deviceRequest"
import { hostForSession } from "../sessionHosts"
import { crewRootOf } from "./crew"
import { crewSessionIds } from "./sessionCrew"
import { sessionParents } from "./sessionOrigins"
import { commandScope, refreshExecutionRequest } from "./durableSend"
import { getDeviceName } from "../routes/hello"

async function may(req: IncomingMessage | undefined, sessionId: string, level: "view" | "interact"): Promise<boolean> {
  if (!req) return !editionModule().auth
  const actual = await accessLevelOf(req, sessionId)
  return Boolean(actual && accessAtLeast(actual, level))
}

export async function crewChatContext(sessionId: string, req?: IncomingMessage) {
  const parents = await sessionParents()
  const rootId = crewRootOf(sessionId, parents)
  if (!await may(req, sessionId, "view") || !await may(req, rootId, "view")) throw new OrchestrationError(403, "Crew chat requires access to its lead session")
  const rootHost = await hostForSession(rootId)
  if (!await rootHost.has(rootId)) throw new OrchestrationError(404, "Crew lead session not found")
  const ids = await crewSessionIds(rootId, { parents, canView: (id) => may(req, id, "view") })
  const store = orchestrationStore()
  const named = ids.map((id) => ({ sessionId: id, name: id === rootId ? "Lead" : parents.get(id)?.name ?? id }))
  const handles = crewChatHandles(named, rootId)
  const members: CrewChatMember[] = await Promise.all(named.map(async (member) => ({ ...member, handle: handles.get(member.sessionId)!, listening: store.chatListener(rootId, member.sessionId).listening, canInteract: await may(req, member.sessionId, "interact") })))
  return { rootId, members, canPost: await may(req, rootId, "interact") }
}

export async function readCrewChat(sessionId: string, options: { after?: number; before?: number; limit?: number; readerSessionId?: string; fetchId?: string } = {}, req?: IncomingMessage): Promise<CrewChatPage> {
  const context = await crewChatContext(sessionId, req)
  watchCrewChat(context.rootId, req)
  const store = orchestrationStore()
  const reader = options.readerSessionId
  if (reader && !context.members.some((member) => member.sessionId === reader && member.canInteract)) throw new OrchestrationError(403, "Only a crew member can fetch its unread messages")
  const after = options.after ?? (reader ? store.chatListener(context.rootId, reader).cursor : undefined)
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrchestrationError(400, "limit must be between 1 and 100")
  for (const cursor of [after, options.before]) if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new OrchestrationError(400, "Chat cursors must be non-negative integers")
  if (after !== undefined && options.before !== undefined) throw new OrchestrationError(400, "Use either after or before")
  const cached = reader && options.fetchId && options.after === undefined ? store.operation(commandScope(req), options.fetchId) : null
  const fetchFingerprint = fingerprint({ rootId: context.rootId, reader, limit })
  if (cached && cached.fingerprint !== fetchFingerprint) throw new OrchestrationError(409, "Fetch ID was reused for another chat read")
  if (cached?.result) return { ...context, ...cached.result as Pick<CrewChatPage, "messages" | "nextCursor" | "hasMore"> }
  const page = store.chatMessages(context.rootId, { after, before: options.before, limit: limit + 1 })
  const hasMore = page.length > limit
  const messages = after !== undefined ? page.slice(0, limit) : page.slice(-limit)
  const nextCursor = messages.at(-1)?.sequence ?? after ?? 0
  if (reader && options.after === undefined) store.finishChatFetch(commandScope(req), options.fetchId, fetchFingerprint, context.rootId, reader, { messages, nextCursor, hasMore })
  void deliverCrewChat(context.rootId, req).catch(() => {})
  return { ...context, messages, nextCursor, hasMore }
}

export async function setCrewChatListening(sessionId: string, targetId: string, listening: boolean, req?: IncomingMessage) {
  const context = await crewChatContext(sessionId, req)
  if (!context.members.some((member) => member.sessionId === targetId && member.canInteract)) throw new OrchestrationError(403, "You cannot change this member's listening setting")
  orchestrationStore().setChatListening(context.rootId, targetId, listening)
  return { rootId: context.rootId, sessionId: targetId, listening }
}

/** How long a post waits for its deliveries before answering with the ones still pending. */
const POST_DELIVERY_WAIT_MS = 2_000

export async function postCrewChat(sessionId: string, input: { text: string; commandId: string; senderSessionId?: string; mentions?: string[] }, req?: IncomingMessage) {
  const context = await crewChatContext(sessionId, req)
  if (!context.canPost) throw new OrchestrationError(403, "Posting to crew chat requires interaction access to the lead session")
  const text = input.text.trim()
  if (!text || text.length > CREW_CHAT_MAX_LENGTH) throw new OrchestrationError(400, `Chat messages must contain 1–${CREW_CHAT_MAX_LENGTH} characters`)
  const sender = input.senderSessionId ? context.members.find((member) => member.sessionId === input.senderSessionId && member.canInteract) : undefined
  if (input.senderSessionId && !sender) throw new OrchestrationError(403, "The sender must be a crew member you can interact with")
  const mentions = [...new Set([...input.mentions ?? [], ...crewChatMentions(text, context.members)])].sort()
  if (mentions.some((id) => !context.members.some((member) => member.sessionId === id && member.canInteract))) throw new OrchestrationError(400, "Mentions must name crew members you can interact with")
  const author: CrewChatAuthor = sender ? { kind: "agent", sessionId: sender.sessionId, name: sender.name } : { kind: "user", name: (req && getRequestPrincipal(req)?.username) || "You" }
  const recipients = context.members.filter((member) => member.sessionId !== sender?.sessionId && member.canInteract && (member.listening || mentions.includes(member.sessionId))).map((member) => ({ sessionId: member.sessionId, kind: mentions.includes(member.sessionId) ? "mention" as const : "notification" as const }))
  const message = orchestrationStore().postChat(commandScope(req), input.commandId, { rootId: context.rootId, author, text, mentions }, recipients)
  watchCrewChat(context.rootId, req)
  // A large crew, or a member on an unreachable device, must not hold the poster; the watcher keeps delivering.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    deliverCrewChat(context.rootId, req).catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, POST_DELIVERY_WAIT_MS) }),
  ])
  clearTimeout(timer)
  const pending = orchestrationStore().chatDeliveries(context.rootId, commandScope(req)).filter((delivery) => delivery.sequence === message.sequence)
  return { message, pending: pending.map((delivery) => ({ sessionId: delivery.sessionId, error: delivery.error })) }
}

const delivering = new Map<string, Promise<void>>()
/** Deliveries a member took whose settle threw; a later pass settles them instead of sending again. */
const sentUnsettled = new Set<string>()
const watched = new Map<string, { rootId: string; req?: IncomingMessage }>()
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0

export function closeCrewChatMonitor(): void {
  generation++
  clearInterval(timer)
  timer = undefined
  watched.clear()
  delivering.clear()
  sentUnsettled.clear()
}

function watchCrewChat(rootId: string, req?: IncomingMessage): void {
  const scope = commandScope(req)
  if (!orchestrationStore().hasPendingChatDeliveries(rootId, scope)) return
  watched.set(JSON.stringify([rootId, scope]), { rootId, req })
  if (timer) return
  beforeOrchestrationClose(closeCrewChatMonitor)
  timer = setInterval(() => {
    for (const [key, watch] of watched) {
      const currentRequest = watch.req ? refreshExecutionRequest(watch.req) : undefined
      if (currentRequest === null || !orchestrationStore().hasPendingChatDeliveries(watch.rootId, commandScope(currentRequest))) { watched.delete(key); continue }
      void deliverCrewChat(watch.rootId, currentRequest).catch(() => {})
    }
    if (!watched.size) { clearInterval(timer); timer = undefined }
  }, 1_000)
  timer.unref()
}

function shellQuoted(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }

export function deliverCrewChat(rootId: string, req?: IncomingMessage): Promise<void> {
  const scope = commandScope(req)
  const key = JSON.stringify([rootId, scope])
  const active = delivering.get(key)
  if (active) return active
  const work = flushCrewChat(rootId, scope, req).finally(() => { if (delivering.get(key) === work) delivering.delete(key) })
  delivering.set(key, work)
  return work
}

/** Attempts before a delivery gives up on a member that fails it; with the backoff below that is about 10 minutes. */
export const CREW_CHAT_DELIVERY_ATTEMPTS = 8
const RETRY_BASE_MS = 5_000
const RETRY_CAP_MS = 5 * 60_000
/** A busy member is reachable and usually free again soon, so it is asked again on a short fixed delay. */
export const CREW_CHAT_BUSY_RETRY_MS = 10_000
/** How long a mention waits on a member that answers busy every time before it gives up. */
export const CREW_CHAT_BUSY_GIVE_UP_MS = 60 * 60_000
/** Busy answers a notice gets before it is skipped. */
export const CREW_CHAT_NOTICE_BUSY_ANSWERS = 3

/** How long to wait after the `attempt`th failure (1-based). */
export function crewChatRetryDelay(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1))
}

type DeliveryFailure = { kind: "unreachable" | "busy" | "failed"; reason: string }

class CrewMemberUnreachable extends Error {}

function deliveryFailure(error: unknown): DeliveryFailure {
  const reason = error instanceof Error && error.message ? error.message : "Chat delivery failed"
  if (error instanceof CrewMemberUnreachable) return { kind: "unreachable", reason }
  // session-send's answer when the session cannot take a message right now; other 409s are permanent.
  if (error instanceof DeviceRequestError && error.status === 409 && error.code === "CONFLICT") return { kind: "busy", reason }
  return { kind: "failed", reason }
}

function deferral(delivery: CrewChatDelivery, { kind, reason }: DeliveryFailure, now: number) {
  if (kind === "busy") {
    const busySince = delivery.busySince || now
    const patience = delivery.kind === "mention" ? CREW_CHAT_BUSY_GIVE_UP_MS : (CREW_CHAT_NOTICE_BUSY_ANSWERS - 1) * CREW_CHAT_BUSY_RETRY_MS
    return { delivery, error: reason, attempts: delivery.attempts, busySince, nextAttemptAt: now + CREW_CHAT_BUSY_RETRY_MS, giveUp: now - busySince >= patience }
  }
  const attempts = delivery.attempts + 1
  return { delivery, error: reason, attempts, busySince: 0, nextAttemptAt: now + crewChatRetryDelay(attempts), giveUp: attempts >= CREW_CHAT_DELIVERY_ATTEMPTS }
}

/**
 * One pass over the deliveries that are due. A member that fails once in a pass is not asked again in
 * that pass, so many messages to an offline device cost one request. A notice to a member out of reach is
 * skipped, and one to a busy member after a few short retries. A mention to a busy member is retried
 * shortly without counting an attempt, for up to an hour; any other failure counts one, backs off, and
 * the last allowed one settles the delivery as `failed`.
 */
async function flushCrewChat(rootId: string, scope: string, req?: IncomingMessage): Promise<void> {
  const activeGeneration = generation
  const store = orchestrationStore()
  const attempted = new Set<string>()
  const blocked = new Map<string, DeliveryFailure>()
  for (;;) {
    const due = store.dueChatDeliveries(rootId, scope, Date.now()).filter((delivery) => !attempted.has(JSON.stringify([delivery.sequence, delivery.sessionId])))
    if (!due.length) return
    const deferrals: ReturnType<typeof deferral>[] = []
    try {
      for (const delivery of due) {
        const key = JSON.stringify([delivery.sequence, delivery.sessionId])
        attempted.add(key)
        if (sentUnsettled.has(key)) { store.settleChatDelivery(delivery, "accepted"); sentUnsettled.delete(key); continue }
        const message = store.chatMessage(delivery.sequence)
        if (!message) { store.settleChatDelivery(delivery, "skipped", "The message no longer exists"); continue }
        let failure = blocked.get(delivery.sessionId)
        if (!failure) {
          let sent = false
          try {
            sent = await sendCrewChatDelivery(store, rootId, delivery, message, req, () => generation !== activeGeneration)
          } catch (error) {
            failure = deliveryFailure(error)
            blocked.set(delivery.sessionId, failure)
          }
          if (generation !== activeGeneration) return
          if (sent) {
            sentUnsettled.add(key)
            store.settleChatDelivery(delivery, "accepted")
            sentUnsettled.delete(key)
          }
        }
        if (!failure) continue
        const next = deferral(delivery, failure, Date.now())
        if (delivery.kind !== "mention" && (failure.kind === "unreachable" || (failure.kind === "busy" && next.giveUp))) store.settleChatDelivery(delivery, "skipped", failure.reason)
        else deferrals.push(next)
      }
    } finally {
      if (generation === activeGeneration) store.deferChatDeliveries(deferrals)
    }
  }
}

async function crewMemberState(sessionId: string) {
  try {
    const host = await hostForSession(sessionId)
    return { host, state: await host.state(sessionId) }
  } catch (error) {
    throw new CrewMemberUnreachable(deliveryFailure(error).reason)
  }
}

/** Sends one message, answering whether the member took it, or throws why it could not. */
async function sendCrewChatDelivery(store: ReturnType<typeof orchestrationStore>, rootId: string, delivery: CrewChatDelivery, message: CrewChatMessage, req: IncomingMessage | undefined, closed: () => boolean): Promise<boolean> {
  const allowed = async () => await may(req, rootId, "interact") && await may(req, delivery.sessionId, "interact")
  if (!await allowed()) throw new Error("Not allowed to message this crew member")
  const { host, state } = await crewMemberState(delivery.sessionId)
  if (closed()) return false
  if (["unreachable", "not_found"].includes(state.outcome)) throw new CrewMemberUnreachable(state.error || "Crew member is unavailable")
  const mentioned = delivery.kind === "mention"
  if (!mentioned && (!store.chatListener(rootId, delivery.sessionId).listening || !state.running || state.activeNotifications === false)) {
    store.settleChatDelivery(delivery, "skipped")
    return false
  }
  const deviceFlag = host.remote ? ` --device ${shellQuoted(getDeviceName())}` : ""
  const fetchCommand = `cogpit-session chat fetch ${shellQuoted(rootId)}${deviceFlag} --after ${Math.max(0, message.sequence - 1)}`
  const replyCommand = `cogpit-session chat post "YOUR_MESSAGE" --crew ${shellQuoted(rootId)}${deviceFlag}`
  if (!await allowed()) throw new Error("Not allowed to message this crew member")
  if (closed()) return false
  // A device's durable queue would hold it out of reach of this host's lead check, so a device
  // delivers it now or answers busy, and this host keeps it pending until then.
  await host.send(delivery.sessionId, formatCrewChatDelivery(message, mentioned, fetchCommand, replyCommand), {
    ...(host.remote ? {} : { commandId: `crew-chat-${fingerprint([rootId, delivery.sequence, delivery.sessionId]).slice(0, 40)}` }),
    intent: state.activeNotifications === false ? "queue" : "steer",
    notification: true,
    ...(!mentioned ? { onlyWhileRunning: true } : {}),
    ...(host.remote ? {} : { leadSessionId: rootId }),
    req,
  })
  return !closed()
}
