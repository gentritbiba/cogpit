import type { InboundKind, KnownThread, SlackLink } from "./types"

/** The parts of a Slack event the router reads. */
export interface SlackEvent {
  type?: string
  subtype?: string
  channel?: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  attachments?: Array<{ is_share?: boolean; is_msg_unfurl?: boolean; author_name?: string; author_id?: string; text?: string; fallback?: string; pretext?: string }>
  files?: Array<{ name?: string; title?: string; mimetype?: string }>
  assistant_thread?: { user_id?: string; channel_id?: string; thread_ts?: string }
}

export interface RouteContext {
  teamId: string
  botUserId: string
  link: SlackLink
  /** Threads the link knows, by {@link threadKey}. */
  threads: Record<string, KnownThread>
}

export interface Delivery {
  key: string
  kind: InboundKind
  channel: string
  threadTs: string
  ts: string
  user: string
  text: string
  forwarded: string[]
  files: string[]
  /** An allowlisted person's DM with the bot the link did not know yet. */
  learnedDm?: string
}

export type Route =
  | { action: "deliver"; delivery: Delivery }
  | { action: "thread"; channel: string; threadTs: string; user: string; learnedDm?: string }
  | { action: "ignore"; reason: string; channel?: string; user?: string; ts?: string }

export const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`

/** Subtypes that are still a person writing; edits, deletions, joins and the rest are not. */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast"])

function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function forwardedOf(event: SlackEvent): string[] {
  return (event.attachments ?? [])
    .filter((attachment) => attachment.is_share || attachment.is_msg_unfurl)
    .map((attachment) => {
      const from = attachment.author_name || attachment.author_id || "someone"
      const body = unescapeSlack(attachment.text || attachment.fallback || attachment.pretext || "").trim()
      return `From ${from}:\n${body}`
    })
}

/**
 * Decide what one Slack event means for a link. Pure: the caller persists a
 * delivery and records a thread. Everything not from an allowlisted person,
 * not new, or not addressed to the bot is ignored with a reason.
 */
export function routeEvent(event: SlackEvent, { teamId, botUserId, link, threads }: RouteContext): Route {
  const type = event.type
  if (type === "assistant_thread_started") {
    const thread = event.assistant_thread
    if (!thread?.channel_id || !thread.thread_ts || !thread.user_id) return { action: "ignore", reason: "assistant thread without ids" }
    if (!link.allow.includes(thread.user_id)) return { action: "ignore", reason: "assistant thread from a user not on the allowlist", user: thread.user_id, channel: thread.channel_id }
    return { action: "thread", channel: thread.channel_id, threadTs: thread.thread_ts, user: thread.user_id, ...(!link.dms.includes(thread.channel_id) && { learnedDm: thread.channel_id }) }
  }
  if (type !== "message" && type !== "app_mention") return { action: "ignore", reason: `event ${type ?? "without a type"}` }

  const where = { channel: event.channel, user: event.user, ts: event.ts }
  if (event.subtype === "message_changed") return { action: "ignore", reason: "edit", ...where }
  if (event.subtype === "message_deleted") return { action: "ignore", reason: "deletion", ...where }
  if (event.bot_id || event.subtype === "bot_message" || event.user === botUserId) return { action: "ignore", reason: "bot message", ...where }
  if (event.subtype && !PERSON_SUBTYPES.has(event.subtype)) return { action: "ignore", reason: `subtype ${event.subtype}`, ...where }
  if (!event.channel || !event.ts || !event.user) return { action: "ignore", reason: "message without channel, ts or user", ...where }
  if (!link.allow.includes(event.user)) return { action: "ignore", reason: "user not on the allowlist", ...where }

  const channel = event.channel
  const isDm = event.channel_type === "im" || (type === "message" && !event.channel_type && channel.startsWith("D"))
  const replyTo = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined
  const threadTs = replyTo ?? event.ts
  const mention = `<@${botUserId}>`
  const mentioned = type === "app_mention" || (event.text ?? "").includes(mention)
  const known = threads[threadKey(channel, threadTs)]

  let kind: InboundKind
  if (isDm) kind = known?.assistant ? "assistant" : replyTo ? "thread" : "dm"
  else if (mentioned) kind = "mention"
  else if (replyTo && known) kind = "thread"
  else return { action: "ignore", reason: "channel message that does not mention the bot", ...where }

  const text = unescapeSlack((event.text ?? "").split(mention).join("").trim())
  const files = (event.files ?? []).map((file) => `${file.name || file.title || "file"}${file.mimetype ? ` (${file.mimetype})` : ""}`)
  const forwarded = forwardedOf(event)
  if (!text && !files.length && !forwarded.length) return { action: "ignore", reason: "empty message", ...where }
  return {
    action: "deliver",
    delivery: {
      key: `${teamId}:${channel}:${event.ts}`,
      kind,
      channel,
      threadTs,
      ts: event.ts,
      user: event.user,
      text,
      forwarded,
      files,
      ...(isDm && !link.dms.includes(channel) && { learnedDm: channel }),
    },
  }
}

/** Where a session may post for a link: the DMs, and channels only when listed. */
export function mayPostTo(link: SlackLink, channel: string): boolean {
  return link.dms.includes(channel) || link.channels.includes(channel)
}
