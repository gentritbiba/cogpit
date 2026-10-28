import { createHash, randomUUID } from "node:crypto"
import type { SlackCall } from "./api"
import { chunkMessage, toMrkdwn } from "./mrkdwn"
import { checkPost, DEFAULT_DAILY_CAP, utcDay } from "./outbound"
import { formatInbound, inboundHeader } from "./prompt"
import { routeEvent, threadKey, type SlackEvent } from "./routing"
import type { SocketModeEnvelope, SocketState } from "./socket"
import { summarizeBot, type SlackStore } from "./store"
import type { InboundMessage, SlackBot, SlackLink, SlackState } from "./types"

export interface SlackConnection {
  state: SocketState
  lastError?: string
  connectedAt?: number
  start(): void
  stop(): void
}

export interface SlackServiceDeps {
  store: SlackStore
  /** A Web API caller for a token. */
  api: (token: string) => SlackCall
  connect: (bot: SlackBot, onEvent: (payload: Record<string, unknown>, envelope: SocketModeEnvelope) => Promise<void>) => SlackConnection
  /**
   * Queue `text` for the session as a steering message, once: a command the
   * queue already holds is not admitted again, and one a restart held is
   * released under a new id. Resolves with the id that now carries it, and
   * whether a restart left its delivery uncertain.
   */
  deliver: (sessionId: string, text: string, commandId: string) => Promise<{ commandId: string; uncertain?: boolean }>
  sessionExists: (sessionId: string) => Promise<boolean>
  /** Wait for the turn a command joined to end; the reply to the message headed `header`, or null when it never settled. */
  turnEnded: (sessionId: string, commandId: string, header: string, signal: AbortSignal) => Promise<TurnEnd | null>
  log?: (message: string) => void
  now?: () => number
  retryMs?: number
}

/** How a watched turn ended: answered, held back by the queue, or with its delivery uncertain. */
export type TurnEnd = { reply: string | null } | { held: true } | { uncertain: true }

export interface LinkOptions {
  sessionId: string
  bot: string
  allow?: string[]
  dms?: string[]
  channels?: string[]
  autoPost?: boolean
  dailyCap?: number
}

export interface ReplyOptions {
  threadTs?: string
  channel?: string
  text: string
}

export class SlackLinkError extends Error {}

/** The owner. Links default to them so a fresh link answers no one else. */
const DEFAULT_ALLOW = ["U01TRP22K28"]
const MAX_RETRY_MS = 5 * 60_000
const KEEP_IGNORED = 80

const commandIdFor = (key: string) => `slack-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`

/** The id a held command is released under: `<id>-r1`, then `-r2`. Deterministic, so a release can be found again. */
export function successorOf(commandId: string): string {
  const match = /^(.*)-r(\d+)$/.exec(commandId)
  return match ? `${match[1]}-r${Number(match[2]) + 1}` : `${commandId}-r1`
}
const linkFor = (state: SlackState, bot: string) => Object.values(state.links).find((link) => link.bot === bot)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const UNCERTAIN = "Cogpit stopped while delivering this message, so it may or may not have arrived; check cogpit-session queue"

function learnDm(state: SlackState, sessionId: string, dm: string | undefined): void {
  const link = state.links[sessionId]
  if (dm && link && !link.dms.includes(dm)) link.dms.push(dm)
}

/** Record activity in a thread, keeping whether it is an Assistant thread unless `assistant` says so. */
function touchThread(state: SlackState, thread: { bot: string; channel: string; threadTs: string; assistant?: boolean }, now: number): void {
  const key = threadKey(thread.channel, thread.threadTs)
  state.threads[key] = { ...thread, assistant: thread.assistant ?? state.threads[key]?.assistant ?? false, lastSeen: now }
}

/**
 * Links sessions to Slack bots. One Socket Mode connection per linked bot
 * receives events; messages from allowlisted people are written to disk,
 * acknowledged, then handed to the session's durable queue as steering
 * messages. Posts go only where the link allows, within its cap.
 */
export class SlackService {
  private readonly connections = new Map<string, SlackConnection>()
  private readonly watchers = new Map<string, AbortController>()
  private readonly seenEvents = new Set<string>()
  private readonly ignored: Array<{ bot: string; at: number; reason: string; channel?: string; user?: string; ts?: string }> = []
  private pumping: Promise<void> | null = null
  private pumpAgain = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(private readonly deps: SlackServiceDeps) {
    this.log = deps.log ?? ((message) => console.log(`[slack] ${message}`))
    this.now = deps.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    // A message whose turn had not ended goes through delivery again: its receipt says whether the restart held it.
    const state = await this.deps.store.update((next) => {
      for (const message of next.inbox) if (message.status === "admitted" && message.awaitingTurn) message.status = "pending"
      return next
    })
    for (const link of Object.values(state.links)) await this.connect(link.bot)
    void this.pump()
  }

  /** Close the connections; resolves once any delivery under way has been recorded. */
  async stop(): Promise<void> {
    this.started = false
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
    for (const watcher of this.watchers.values()) watcher.abort()
    this.watchers.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.pumping
  }

  // ── Bots ───────────────────────────────────────────────────────────────

  async addBot(name: string, botToken: string, appToken: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new SlackLinkError("A bot name is letters, digits, - and _")
    if (!botToken.startsWith("xoxb-")) throw new SlackLinkError("The bot token must be an xoxb- token")
    if (!appToken.startsWith("xapp-")) throw new SlackLinkError("The app token must be an xapp- token with connections:write")
    const identity = await this.deps.api(botToken)("auth.test")
    const bot: SlackBot = { name, botToken, appToken, botUserId: String(identity.user_id), teamId: String(identity.team_id), ...(typeof identity.team === "string" && { teamName: identity.team }), addedAt: this.now() }
    await this.deps.store.saveBot(bot)
    if (this.connections.has(name)) {
      this.disconnect(name)
      await this.connect(name)
    }
    return summarizeBot(bot)
  }

  async removeBot(name: string): Promise<boolean> {
    const link = linkFor(await this.deps.store.read(), name)
    if (link) throw new SlackLinkError(`${name} is linked to session ${link.sessionId}; unlink it first`)
    return this.deps.store.removeBot(name)
  }

  async bots() {
    return (await this.deps.store.listBots()).map(summarizeBot)
  }

  // ── Links ──────────────────────────────────────────────────────────────

  async link(options: LinkOptions): Promise<SlackLink> {
    const bot = await this.deps.store.bot(options.bot)
    if (!bot) throw new SlackLinkError(`No Slack bot named ${options.bot}; add it with: cogpit-session slack bot add ${options.bot} --env-file FILE`)
    if (!await this.deps.sessionExists(options.sessionId)) throw new SlackLinkError(`Session ${options.sessionId} is not on this machine; link it on the Cogpit server that runs it`)
    const state = await this.deps.store.read()
    const taken = linkFor(state, bot.name)
    if (taken && taken.sessionId !== options.sessionId) throw new SlackLinkError(`${bot.name} is already linked to session ${taken.sessionId}; unlink it there first`)
    const current = state.links[options.sessionId]
    if (current && current.bot !== bot.name) throw new SlackLinkError(`Session ${options.sessionId} is linked to ${current.bot}; unlink it first`)
    const allow = options.allow?.length ? options.allow : current?.allow ?? DEFAULT_ALLOW
    if (!allow.every((user) => /^[UW][A-Z0-9]+$/.test(user))) throw new SlackLinkError("--allow takes Slack user ids such as U01TRP22K28")
    const channels = options.channels ?? current?.channels ?? []
    if (!channels.every((channel) => /^[CG][A-Z0-9]+$/.test(channel))) throw new SlackLinkError("--channel takes Slack channel ids such as C0123ABCD")
    const dms = new Set([...(current?.dms ?? []), ...(options.dms ?? [])])
    if (![...dms].every((channel) => /^D[A-Z0-9]+$/.test(channel))) throw new SlackLinkError("--dm takes direct-message channel ids such as D0BK06FJKHD")
    // The DM of each allowlisted person with the bot; one Slack has not opened yet is learnt from their first message.
    const api = this.deps.api(bot.botToken)
    for (const user of allow) {
      try {
        const opened = await api("conversations.open", { users: user })
        const id = (opened.channel as { id?: unknown } | undefined)?.id
        if (typeof id === "string") dms.add(id)
      } catch (error) {
        this.log(`Could not open the DM with ${user} (${errorText(error)}); it is learnt from their first message`)
      }
    }
    const link: SlackLink = {
      sessionId: options.sessionId,
      bot: bot.name,
      allow,
      dms: [...dms],
      channels,
      autoPost: options.autoPost ?? current?.autoPost ?? false,
      dailyCap: options.dailyCap ?? current?.dailyCap ?? DEFAULT_DAILY_CAP,
      createdAt: current?.createdAt ?? this.now(),
    }
    await this.deps.store.update((next) => { next.links[link.sessionId] = link })
    await this.connect(bot.name)
    return link
  }

  async unlink(sessionId: string): Promise<{ unlinked: boolean; droppedPending: number }> {
    const result = await this.deps.store.update((state) => {
      const link = state.links[sessionId]
      if (!link) return { unlinked: false, droppedPending: 0, bot: undefined }
      delete state.links[sessionId]
      const before = state.inbox.length
      state.inbox = state.inbox.filter((message) => !(message.sessionId === sessionId && message.status === "pending"))
      return { unlinked: true, droppedPending: before - state.inbox.length, bot: link.bot }
    })
    if (result.bot) this.disconnect(result.bot)
    return { unlinked: result.unlinked, droppedPending: result.droppedPending }
  }

  async status(sessionId?: string) {
    const state = await this.deps.store.read()
    const today = utcDay(this.now())
    const links = Object.values(state.links)
      .filter((link) => !sessionId || link.sessionId === sessionId)
      .map((link) => {
        const connection = this.connections.get(link.bot)
        const inbox = state.inbox.filter((message) => message.sessionId === link.sessionId)
        return {
          ...link,
          connection: connection ? { state: connection.state, ...(connection.lastError && { lastError: connection.lastError }), ...(connection.connectedAt && { connectedAt: new Date(connection.connectedAt).toISOString() }) } : { state: "stopped" },
          pending: inbox.filter((message) => message.status === "pending").map(({ key, attempts, lastError }) => ({ key, attempts, lastError })),
          awaitingTurn: inbox.filter((message) => message.awaitingTurn).length,
          uncertain: inbox.filter((message) => message.status === "admitted" && message.lastError).map(({ key, commandId, lastError }) => ({ key, commandId, lastError })),
          postedToday: state.sent.filter((record) => record.bot === link.bot && utcDay(record.at) === today).length,
          recentlyIgnored: this.ignored.filter((entry) => entry.bot === link.bot).slice(-5).map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
        }
      })
    return { links, bots: await this.bots() }
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  async reply(sessionId: string, options: ReplyOptions): Promise<{ posted: boolean; channel: string; threadTs?: string; ts?: string; note?: string }> {
    const state = await this.deps.store.read()
    const link = state.links[sessionId]
    if (!link) throw new SlackLinkError(`Session ${sessionId} is not linked to Slack`)
    const text = options.text.trim()
    if (!text) throw new SlackLinkError("Nothing to post")
    const channel = options.channel ?? (options.threadTs && Object.values(state.threads).find((thread) => thread.bot === link.bot && thread.threadTs === options.threadTs)?.channel) ?? link.dms[0]
    if (!channel) throw new SlackLinkError("This link knows no DM yet: ask the allowlisted person to message the bot once, or link again with --dm")
    return this.post(link, { channel, threadTs: options.threadTs, text })
  }

  private async post(link: SlackLink, request: { channel: string; threadTs?: string; text: string }) {
    const bot = await this.deps.store.bot(link.bot)
    if (!bot) throw new SlackLinkError(`The bot ${link.bot} was removed`)
    const chunks = chunkMessage(toMrkdwn(request.text))
    const ids: string[] = chunks.map(() => randomUUID())
    // Each chunk is a post: all are checked against the cap and reserved in one write, so two replies at once cannot both pass it.
    const check = await this.deps.store.update((state) => {
      const result = checkPost(state, link, request, this.now(), chunks.length)
      if (result.allowed) for (const id of ids) state.sent.push({ id, bot: link.bot, at: this.now(), channel: request.channel, ...(request.threadTs && { threadTs: request.threadTs }), hash: result.hash, ts: "" })
      return result
    })
    if (!check.allowed) {
      if (check.duplicate) return { posted: false, channel: request.channel, threadTs: request.threadTs, note: check.reason }
      throw new SlackLinkError(check.reason)
    }
    const api = this.deps.api(bot.botToken)
    const posted: string[] = []
    try {
      for (const chunk of chunks) {
        const result = await api("chat.postMessage", { channel: request.channel, text: chunk, mrkdwn: true, unfurl_links: false, unfurl_media: false, ...(request.threadTs && { thread_ts: request.threadTs }) })
        posted.push(String(result.ts))
      }
    } finally {
      // Chunks that went out keep their reservation; the rest are released.
      await this.deps.store.update((state) => {
        state.sent = state.sent.filter((record) => !ids.slice(posted.length).includes(record.id))
        for (const [index, ts] of posted.entries()) {
          const record = state.sent.find((entry) => entry.id === ids[index])
          if (record) record.ts = ts
        }
        if (posted.length) touchThread(state, { bot: link.bot, channel: request.channel, threadTs: request.threadTs ?? posted[0] }, this.now())
      })
    }
    return { posted: true, channel: request.channel, threadTs: request.threadTs, ts: posted[0] }
  }

  private async setStatus(bot: SlackBot, message: InboundMessage, status: string): Promise<void> {
    if (message.kind !== "assistant" && message.kind !== "dm" && message.kind !== "thread") return
    try {
      await this.deps.api(bot.botToken)("assistant.threads.setStatus", { channel_id: message.channel, thread_ts: message.threadTs, status })
    } catch {
      // Only Assistant threads take a status; elsewhere Slack refuses and that is fine.
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────

  private async connect(botName: string): Promise<void> {
    if (this.connections.has(botName) || !this.started) return
    const bot = await this.deps.store.bot(botName)
    if (!bot) return
    const connection = this.deps.connect(bot, (payload) => this.receive(bot.name, payload))
    this.connections.set(botName, connection)
    connection.start()
  }

  private disconnect(botName: string): void {
    this.connections.get(botName)?.stop()
    this.connections.delete(botName)
  }

  private noteIgnored(bot: string, reason: string, where: { channel?: string; user?: string; ts?: string } = {}): void {
    this.log(`${bot}: ignored ${reason}${where.channel ? ` in ${where.channel}` : ""}${where.user ? ` from ${where.user}` : ""}`)
    this.ignored.push({ bot, at: this.now(), reason, ...where })
    if (this.ignored.length > KEEP_IGNORED) this.ignored.splice(0, this.ignored.length - KEEP_IGNORED)
  }

  /** Resolves once the event is safely on disk (or deliberately dropped): only then is it acknowledged. */
  async receive(botName: string, payload: Record<string, unknown>): Promise<void> {
    const eventId = typeof payload.event_id === "string" ? payload.event_id : undefined
    if (eventId && this.seenEvents.has(eventId)) return
    const bot = await this.deps.store.bot(botName)
    const state = await this.deps.store.read()
    const link = linkFor(state, botName)
    if (!bot || !link) return
    const event = payload.event as SlackEvent | undefined
    if (!event) return
    const route = routeEvent(event, { teamId: bot.teamId, botUserId: bot.botUserId, link, threads: state.threads })
    if (route.action === "ignore") {
      this.noteIgnored(botName, route.reason, { channel: route.channel, user: route.user, ts: route.ts })
    } else if (route.action === "thread") {
      await this.deps.store.update((next) => {
        learnDm(next, link.sessionId, route.learnedDm)
        touchThread(next, { bot: botName, channel: route.channel, threadTs: route.threadTs, assistant: true }, this.now())
      })
      this.log(`${botName}: Assistant thread ${route.threadTs} opened by ${route.user}`)
    } else {
      const { delivery } = route
      const added = await this.deps.store.update((next) => {
        learnDm(next, link.sessionId, delivery.learnedDm)
        touchThread(next, { bot: botName, channel: delivery.channel, threadTs: delivery.threadTs }, this.now())
        if (next.inbox.some((message) => message.key === delivery.key)) return false
        const { learnedDm: _learned, ...fields } = delivery
        next.inbox.push({ ...fields, bot: botName, sessionId: link.sessionId, receivedAt: this.now(), status: "pending", commandId: commandIdFor(delivery.key), attempts: 0 })
        return true
      })
      if (added) this.log(`${botName}: ${delivery.kind} from ${delivery.user} in ${delivery.channel} (thread ${delivery.threadTs}) queued for ${link.sessionId}`)
      // A resend of a message already queued still nudges delivery, in case the first attempt stalled.
      void this.pump()
    }
    if (eventId) {
      this.seenEvents.add(eventId)
      if (this.seenEvents.size > 2000) this.seenEvents.delete(this.seenEvents.values().next().value!)
    }
  }

  /** Hand pending messages to their sessions, oldest first; failures wait and try again. */
  pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return this.pumping
    }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false
        await this.deliverPending()
      } while (this.pumpAgain && this.started)
    })().finally(() => { this.pumping = null })
    return this.pumping
  }

  private async deliverPending(): Promise<void> {
    const state = await this.deps.store.read()
    const pending = state.inbox.filter((message) => message.status === "pending").sort((a, b) => a.receivedAt - b.receivedAt)
    let nextRetry = Infinity
    const blocked = new Set<string>()
    for (const queued of pending) {
      if (!this.started) return
      // Deliveries take time, and an unlink or another pass may have changed things meanwhile.
      const current = await this.deps.store.read()
      const message = current.inbox.find((entry) => entry.key === queued.key && entry.status === "pending")
      const link = message && current.links[message.sessionId]
      if (!message || !link) continue
      // Keep each session's messages in order: one that failed holds back those after it.
      if (blocked.has(message.sessionId)) continue
      let outcome: Awaited<ReturnType<SlackServiceDeps["deliver"]>>
      try {
        outcome = await this.deps.deliver(message.sessionId, formatInbound(message, link), message.commandId)
      } catch (error) {
        const reason = errorText(error)
        await this.deps.store.update((next) => {
          const stored = next.inbox.find((entry) => entry.key === message.key)
          if (stored) { stored.attempts++; stored.lastError = reason }
        })
        this.log(`Delivery to ${message.sessionId} failed (${reason}); will retry`)
        blocked.add(message.sessionId)
        nextRetry = Math.min(nextRetry, this.backoff(message.attempts + 1))
        continue
      }
      const admitted = await this.deps.store.update((next) => {
        const stored = next.inbox.find((entry) => entry.key === message.key)
        if (!stored) return undefined
        stored.status = "admitted"
        stored.commandId = outcome.commandId
        if (outcome.uncertain) { stored.lastError = UNCERTAIN; delete stored.awaitingTurn } else { stored.awaitingTurn = true; delete stored.lastError }
        return stored
      })
      const bot = await this.deps.store.bot(link.bot)
      if (!bot || !admitted) continue
      if (outcome.uncertain) {
        this.log(`${message.key}: ${UNCERTAIN}`)
        await this.setStatus(bot, admitted, "")
      } else {
        await this.setStatus(bot, admitted, "is thinking…")
        this.watch(admitted)
      }
    }
    if (nextRetry < Infinity) this.retryIn(nextRetry)
  }

  private backoff(attempts: number): number {
    return Math.min((this.deps.retryMs ?? 15_000) * 2 ** (attempts - 1), MAX_RETRY_MS)
  }

  private retryIn(ms: number): void {
    if (!this.started || this.retryTimer) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.pump() }, ms)
    this.retryTimer.unref?.()
  }

  /** When the turn a message joined ends: post its answer if the link says so, and clear the thread's status. */
  private watch(message: InboundMessage): void {
    if (this.watchers.has(message.key)) return
    const controller = new AbortController()
    this.watchers.set(message.key, controller)
    void (async () => {
      const ended = await this.deps.turnEnded(message.sessionId, message.commandId, inboundHeader(message), controller.signal).catch(() => null)
      if (controller.signal.aborted) return
      if (ended && "held" in ended) {
        // The queue held it after all: back to the inbox, whose delivery releases it.
        const attempts = await this.deps.store.update((next) => {
          const stored = next.inbox.find((entry) => entry.key === message.key)
          if (stored) { stored.status = "pending"; stored.attempts++ }
          return stored?.attempts ?? 1
        })
        this.retryIn(this.backoff(attempts))
        return
      }
      if (ended && "uncertain" in ended) {
        this.log(`${message.key}: ${UNCERTAIN}`)
        await this.deps.store.update((next) => {
          const stored = next.inbox.find((entry) => entry.key === message.key)
          if (stored) { stored.lastError = UNCERTAIN; delete stored.awaitingTurn }
        })
      }
      const state = await this.deps.store.read()
      const link = state.links[message.sessionId]
      const bot = link && await this.deps.store.bot(link.bot)
      if (link && bot) {
        const answered = state.sent.some((record) => record.bot === link.bot && record.channel === message.channel && record.threadTs === message.threadTs && record.at >= message.receivedAt)
        if (link.autoPost && ended && "reply" in ended && ended.reply && !answered) {
          await this.post(link, { channel: message.channel, threadTs: message.threadTs, text: ended.reply }).catch((error: unknown) => {
            this.log(`Automatic post to ${message.channel} failed: ${errorText(error)}`)
          })
        }
        await this.setStatus(bot, message, "")
      }
      await this.deps.store.update((next) => {
        const stored = next.inbox.find((entry) => entry.key === message.key)
        if (stored) delete stored.awaitingTurn
      })
    })().finally(() => this.watchers.delete(message.key))
  }
}
