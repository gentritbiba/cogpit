/** Slack links as the server reports them to the app. Never carries tokens. */

/** A session listening to a bot. One session per bot, one bot per session. */
export interface SlackLink {
  sessionId: string
  bot: string
  /** Slack users whose messages reach the session. */
  allow: string[]
  /** Direct-message channels of allowlisted users with the bot: always postable. */
  dms: string[]
  /** Channels the session may also read mentions in and post to. Empty unless listed. */
  channels: string[]
  /** Post the turn's answer into the thread the message came from. */
  autoPost: boolean
  /** Posts per UTC day, replies and automatic posts together, each chunk counted. */
  dailyCap: number
  createdAt: number
}

export interface SlackBotSummary {
  name: string
  botUserId: string
  teamId: string
  teamName?: string
  addedAt: number
}

export type SlackConnectionState = "connecting" | "connected" | "reconnecting" | "stopped" | "failed"

export interface SlackLinkStatus extends SlackLink {
  connection: { state: SlackConnectionState; lastError?: string; connectedAt?: string }
  pending: Array<{ key: string; attempts: number; lastError?: string }>
  awaitingTurn: number
  uncertain: Array<{ key: string; commandId: string; lastError?: string }>
  postedToday: number
  recentlyIgnored: Array<{ bot: string; at: string; reason: string; channel?: string; user?: string; ts?: string }>
}

/** GET /api/slack */
export interface SlackLinksReport {
  /** False on a Cogpit with accounts, which cannot link sessions yet. */
  available: boolean
  bots: SlackBotSummary[]
  /** `title` is null when the session's transcript is gone. */
  links: Array<SlackLinkStatus & { title: string | null }>
}
