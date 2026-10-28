import { sha256Hex } from "../lib/sha256"
import { mayPostTo } from "./routing"
import type { SlackLink, SlackState } from "./types"

export const DEFAULT_DAILY_CAP = 20
const DUPLICATE_WINDOW_MS = 30 * 60_000

export interface PostRequest {
  channel: string
  threadTs?: string
  text: string
}

export type PostCheck = { allowed: true; hash: string } | { allowed: false; duplicate?: boolean; reason: string }

export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/**
 * Whether a link may make this post: only to its DMs and listed channels,
 * within its daily cap for all `posts` it splits into, and not the same text to the same place twice in half
 * an hour. A duplicate is dropped quietly, as notify-owner does.
 */
export function checkPost(state: SlackState, link: SlackLink, request: PostRequest, now = Date.now(), posts = 1): PostCheck {
  if (!mayPostTo(link, request.channel)) return { allowed: false, reason: `This link may not post to ${request.channel}: only its DMs (${link.dms.join(", ") || "none yet"}) and the channels it lists` }
  const hash = sha256Hex(JSON.stringify([request.channel, request.threadTs ?? "", request.text.trim()])).slice(0, 16)
  const mine = state.sent.filter((record) => record.bot === link.bot)
  if (mine.some((record) => record.hash === hash && now - record.at < DUPLICATE_WINDOW_MS)) return { allowed: false, duplicate: true, reason: "The same text went to the same place in the last 30 minutes, so it was dropped" }
  const today = utcDay(now)
  const used = mine.filter((record) => utcDay(record.at) === today).length
  if (used + posts > link.dailyCap) return { allowed: false, reason: `Daily cap of ${link.dailyCap} Slack posts reached${posts > 1 ? ` (this reply needs ${posts}, ${Math.max(0, link.dailyCap - used)} left)` : ""}; it resets at 00:00 UTC` }
  return { allowed: true, hash }
}
