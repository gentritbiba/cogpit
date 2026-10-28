import type { SlackBotSummary, SlackLink } from "../../shared/contracts/slack"

export type { SlackBotSummary, SlackLink }

/** A Slack app Cogpit connects to over Socket Mode. Holds secrets: never log or return it whole. */
export interface SlackBot extends SlackBotSummary {
  /** xoxb- token: Web API calls. */
  botToken: string
  /** xapp- token with connections:write: the Socket Mode connection. */
  appToken: string
}

export type InboundKind = "dm" | "assistant" | "thread" | "mention"

/** A message from an allowlisted person, kept until the session's queue owns it. */
export interface InboundMessage {
  /** `<team>:<channel>:<ts>`: one per Slack message, so the app_mention and message events for it collapse. */
  key: string
  bot: string
  sessionId: string
  kind: InboundKind
  channel: string
  /** The thread replies go to: the parent's ts, or the message's own for a top-level one. */
  threadTs: string
  ts: string
  user: string
  text: string
  /** Messages the person forwarded or shared, kept apart from their own words. */
  forwarded: string[]
  files: string[]
  receivedAt: number
  status: "pending" | "admitted"
  commandId: string
  attempts: number
  lastError?: string
  /** Set while the turn it started is still to be answered or have its status cleared. */
  awaitingTurn?: boolean
}

/** A thread the link has seen an allowlisted person in, or opened as an Assistant thread. */
export interface KnownThread {
  bot: string
  channel: string
  threadTs: string
  assistant: boolean
  lastSeen: number
}

/** One post the link made (one chunk of a long reply), for the daily cap and the duplicate check. */
export interface SentRecord {
  id: string
  bot: string
  at: number
  channel: string
  threadTs?: string
  hash: string
  ts: string
}

export interface SlackState {
  version: 1
  links: Record<string, SlackLink>
  inbox: InboundMessage[]
  threads: Record<string, KnownThread>
  sent: SentRecord[]
}
