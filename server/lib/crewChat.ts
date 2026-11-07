import type { IncomingMessage } from "node:http"
import { CREW_CHAT_MAX_LENGTH, crewChatHandles, crewChatMentions, formatCrewChatDelivery, type CrewChatAuthor, type CrewChatMember, type CrewChatPage } from "../../shared/contracts/crewChat"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { accessLevelOf, editionModule, getRequestPrincipal } from "../edition"
import { beforeOrchestrationClose, orchestrationStore } from "../orchestration/storage"
import { fingerprint, OrchestrationError } from "../orchestration/store"
import { hostForSession } from "../sessionHosts"
import { crewRootOf } from "./crew"
import { crewSessionIds } from "./sessionCrew"
import { sessionOriginsRevision, sessionParents } from "./sessionOrigins"
import { commandScope, refreshExecutionRequest } from "./durableSend"
import { getDeviceName } from "../routes/hello"

async function may(req: IncomingMessage | undefined, sessionId: string, level: "view" | "interact"): Promise<boolean> {
  if (!req) return !editionModule().auth
  const actual = await accessLevelOf(req, sessionId)
  return Boolean(actual && accessAtLeast(actual, level))
}

interface CrewChatAccess {
  rootId: string
  named: Omit<CrewChatMember, "listening">[]
  canPost: boolean
}

export interface CrewChatContext {
  rootId: string
  members: CrewChatMember[]
  membersVersion: string
  canPost: boolean
}

async function readAccess(sessionId: string, req?: IncomingMessage): Promise<CrewChatAccess> {
  const parents = await sessionParents()
  const rootId = crewRootOf(sessionId, parents)
  if (!await may(req, sessionId, "view") || !await may(req, rootId, "view")) throw new OrchestrationError(403, "Crew chat requires access to its lead session")
  const rootHost = await hostForSession(rootId)
  if (!await rootHost.has(rootId)) throw new OrchestrationError(404, "Crew lead session not found")
  const ids = await crewSessionIds(rootId, { parents, canView: (id) => may(req, id, "view") })
  const named = ids.map((id) => ({ sessionId: id, name: id === rootId ? "Lead" : parents.get(id)?.name ?? id }))
  const handles = crewChatHandles(named, rootId)
  return {
    rootId,
    named: await Promise.all(named.map(async (member) => ({ ...member, handle: handles.get(member.sessionId)!, canInteract: await may(req, member.sessionId, "interact") }))),
    canPost: await may(req, rootId, "interact"),
  }
}

function withListeners(access: CrewChatAccess): CrewChatContext {
  const listeners = orchestrationStore().chatListeners(access.rootId)
  const members = access.named.map(({ sessionId, name, handle, canInteract }) => ({ sessionId, name, handle, listening: listeners.get(sessionId) ?? true, canInteract }))
  return { rootId: access.rootId, members, membersVersion: fingerprint(members).slice(0, 16), canPost: access.canPost }
}

/** The crew a session chats in, as the caller may see it, read fresh: what posts and listening changes act on. */
export async function crewChatContext(sessionId: string, req?: IncomingMessage): Promise<CrewChatContext> {
  return withListeners(await readAccess(sessionId, req))
}

/** How long a read reuses what the caller may see in a crew whose lineage did not change. */
const ACCESS_REUSE_MS = 5_000
const readAccessCache = new Map<string, { revision: number; at: number; access: Promise<CrewChatAccess> }>()

/**
 * The crew for a chat read. Polls reuse the crew's members and the caller's
 * access to them until the lineage changes or a few seconds pass; listening
 * flags are read every time.
 */
export async function crewChatReadContext(sessionId: string, req?: IncomingMessage): Promise<CrewChatContext> {
  const key = JSON.stringify([commandScope(req), sessionId])
  const revision = sessionOriginsRevision()
  const now = Date.now()
  let entry = readAccessCache.get(key)
  if (!entry || entry.revision !== revision || now - entry.at >= ACCESS_REUSE_MS) {
    for (const [known, value] of readAccessCache) if (now - value.at >= ACCESS_REUSE_MS) readAccessCache.delete(known)
    entry = { revision, at: now, access: readAccess(sessionId, req) }
    readAccessCache.set(key, entry)
    const settled = entry
    settled.access.catch(() => { if (readAccessCache.get(key) === settled) readAccessCache.delete(key) })
  }
  return withListeners(await entry.access)
}

export async function readCrewChat(sessionId: string, options: { after?: number; before?: number; limit?: number; readerSessionId?: string; fetchId?: string } = {}, req?: IncomingMessage, known?: CrewChatContext): Promise<CrewChatPage> {
  const context = known ?? await crewChatContext(sessionId, req)
  const store = orchestrationStore()
  const reader = options.readerSessionId
  if (reader && !context.members.some((member) => member.sessionId === reader && member.canInteract)) throw new OrchestrationError(403, "Only a crew member can fetch its unread messages")
  const after = options.after ?? (reader ? store.chatListener(context.rootId, reader).cursor : undefined)
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrchestrationError(400, "limit must be between 1 and 100")
  for (const cursor of [after, options.before]) if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new OrchestrationError(400, "Chat cursors must be non-negative integers")
  if (after !== undefined && options.before !== undefined) throw new OrchestrationError(400, "Use either after or before")
  if (store.chatDeliveries(context.rootId, commandScope(req)).length) {
    watchCrewChat(context.rootId, req)
    void deliverCrewChat(context.rootId, req).catch(() => {})
  }
  const cached = reader && options.fetchId && options.after === undefined ? store.operation(commandScope(req), options.fetchId) : null
  const fetchFingerprint = fingerprint({ rootId: context.rootId, reader, limit })
  if (cached && cached.fingerprint !== fetchFingerprint) throw new OrchestrationError(409, "Fetch ID was reused for another chat read")
  if (cached?.result) return { ...context, ...cached.result as Pick<CrewChatPage, "messages" | "nextCursor" | "hasMore"> }
  const page = store.chatMessages(context.rootId, { after, before: options.before, limit: limit + 1 })
  const hasMore = page.length > limit
  const messages = after !== undefined ? page.slice(0, limit) : page.slice(-limit)
  const nextCursor = messages.at(-1)?.sequence ?? after ?? 0
  if (reader && options.after === undefined) store.finishChatFetch(commandScope(req), options.fetchId, fetchFingerprint, context.rootId, reader, { messages, nextCursor, hasMore })
  return { ...context, messages, nextCursor, hasMore }
}

export async function setCrewChatListening(sessionId: string, targetId: string, listening: boolean, req?: IncomingMessage, known?: CrewChatContext) {
  const context = known ?? await crewChatContext(sessionId, req)
  if (!context.members.some((member) => member.sessionId === targetId && member.canInteract)) throw new OrchestrationError(403, "You cannot change this member's listening setting")
  orchestrationStore().setChatListening(context.rootId, targetId, listening)
  return { rootId: context.rootId, sessionId: targetId, listening }
}

/** How long a post waits for its deliveries before answering with the ones still pending. */
const POST_DELIVERY_WAIT_MS = 2_000

export async function postCrewChat(sessionId: string, input: { text: string; commandId: string; senderSessionId?: string; mentions?: string[] }, req?: IncomingMessage, known?: CrewChatContext) {
  const context = known ?? await crewChatContext(sessionId, req)
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
const watched = new Map<string, { rootId: string; req?: IncomingMessage }>()
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0

export function closeCrewChatMonitor(): void {
  generation++
  clearInterval(timer)
  timer = undefined
  watched.clear()
  delivering.clear()
}

/**
 * Keeps delivering a crew's pending messages in the background, in the
 * reader's scope; nothing when none is pending. One indexed read, so any
 * poll of the crew can call it.
 */
export function watchCrewChat(rootId: string, req?: IncomingMessage): void {
  const scope = commandScope(req)
  if (!orchestrationStore().chatDeliveries(rootId, scope).length) return
  watched.set(JSON.stringify([rootId, scope]), { rootId, req })
  if (timer) return
  beforeOrchestrationClose(closeCrewChatMonitor)
  timer = setInterval(() => {
    for (const [key, watch] of watched) {
      const currentRequest = watch.req ? refreshExecutionRequest(watch.req) : undefined
      if (currentRequest === null || !orchestrationStore().chatDeliveries(watch.rootId, commandScope(currentRequest)).length) { watched.delete(key); continue }
      void deliverCrewChat(watch.rootId, currentRequest).catch(() => {})
    }
    if (!watched.size) { clearInterval(timer); timer = undefined }
  }, 1_000)
  timer.unref()
}

/**
 * Re-arms delivery for every crew with messages still on their way after a
 * restart, which otherwise waits for the crew's next read or post. Only the
 * personal edition can act without a signed-in request.
 */
export function resumeLocalCrewChat(): void {
  if (editionModule().auth) return
  try {
    for (const rootId of orchestrationStore().chatRootsWithPendingDeliveries(commandScope())) watchCrewChat(rootId)
  } catch (error) {
    console.error("[crew chat] could not resume pending deliveries", error)
  }
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

async function flushCrewChat(rootId: string, scope: string, req?: IncomingMessage): Promise<void> {
  const activeGeneration = generation
  const store = orchestrationStore()
  const attempted = new Set<string>()
  for (;;) {
    const pending = store.chatDeliveries(rootId, scope).filter((delivery) => !attempted.has(JSON.stringify([delivery.sequence, delivery.sessionId])))
    if (!pending.length) return
    for (const delivery of pending) {
      attempted.add(JSON.stringify([delivery.sequence, delivery.sessionId]))
      const message = store.chatMessage(delivery.sequence)
      if (!message) continue
      try {
        if (!await may(req, rootId, "interact") || !await may(req, delivery.sessionId, "interact")) continue
        const host = await hostForSession(delivery.sessionId)
        const state = await host.state(delivery.sessionId)
        if (generation !== activeGeneration) return
        if (["unreachable", "not_found"].includes(state.outcome)) throw new Error(state.error || "Crew member is unavailable")
        const mentioned = delivery.kind === "mention"
        if (!mentioned && (!store.chatListener(rootId, delivery.sessionId).listening || !state.running || state.activeNotifications === false)) {
          store.updateChatDelivery(delivery, "skipped")
          continue
        }
        const deviceFlag = host.remote ? ` --device ${shellQuoted(getDeviceName())}` : ""
        const fetchCommand = `cogpit-session chat fetch ${shellQuoted(rootId)}${deviceFlag} --after ${Math.max(0, message.sequence - 1)}`
        const replyCommand = `cogpit-session chat post "YOUR_MESSAGE" --crew ${shellQuoted(rootId)}${deviceFlag}`
        if (!await may(req, rootId, "interact") || !await may(req, delivery.sessionId, "interact")) continue
        if (generation !== activeGeneration) return
        // A device's durable queue would hold it out of reach of this host's lead check, so a device
        // delivers it now or answers busy, and this host keeps it pending until then.
        const result = await host.send(delivery.sessionId, formatCrewChatDelivery(message, mentioned, fetchCommand, replyCommand), {
          ...(host.remote ? {} : { commandId: `crew-chat-${fingerprint([rootId, delivery.sequence, delivery.sessionId]).slice(0, 40)}` }),
          intent: state.activeNotifications === false ? "queue" : "steer",
          notification: true,
          ...(!mentioned ? { onlyWhileRunning: true } : {}),
          ...(host.remote ? {} : { leadSessionId: rootId }),
          req,
        })
        if (generation !== activeGeneration) return
        if (result.delivery === "busy") throw new Error("Crew member could not accept this message")
        store.updateChatDelivery(delivery, "accepted")
      } catch (error) {
        if (generation !== activeGeneration) return
        store.updateChatDelivery(delivery, "pending", error instanceof Error ? error.message : "Chat delivery failed")
      }
    }
  }
}
