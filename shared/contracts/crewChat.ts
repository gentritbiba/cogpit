import { CREW_CHAT_DELIVERY_RE } from "../session/automatedPrompts"

export const CREW_CHAT_MAX_LENGTH = 8_000

export interface CrewChatAuthor {
  kind: "user" | "agent"
  name: string
  sessionId?: string
}

export interface CrewChatMessage {
  sequence: number
  id: string
  rootId: string
  author: CrewChatAuthor
  text: string
  mentions: string[]
  createdAt: number
}

export interface CrewChatMember {
  sessionId: string
  name: string
  handle: string
  listening: boolean
  canInteract: boolean
}

export interface CrewChatPage {
  rootId: string
  messages: CrewChatMessage[]
  members: CrewChatMember[]
  nextCursor: number
  hasMore: boolean
  canPost: boolean
}

export interface CrewChatDelivery {
  sequence: number
  sessionId: string
  scope: string
  kind: "mention" | "notification"
  /** `failed` is terminal: the member failed every attempt or stayed busy too long; `error` keeps the last reason. */
  state: "pending" | "accepted" | "skipped" | "failed"
  error?: string
  /** Failed attempts so far. */
  attempts: number
  /** Epoch ms before which the delivery is not tried again. */
  nextAttemptAt: number
  /** Epoch ms of the first busy answer in the current run of them, or 0. */
  busySince: number
}

export function crewChatHandles(members: readonly { sessionId: string; name: string }[], rootId: string): Map<string, string> {
  const handles = new Map<string, string>()
  const used = new Set<string>()
  for (const member of members) {
    const base = member.sessionId === rootId ? "lead" : member.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent"
    let handle = base
    for (let suffix = 2; used.has(handle); suffix++) handle = `${base}-${suffix}`
    used.add(handle)
    handles.set(member.sessionId, handle)
  }
  return handles
}

export function crewChatMentions(text: string, members: readonly Pick<CrewChatMember, "sessionId" | "handle">[]): string[] {
  const tokens = new Set([...text.matchAll(/(?:^|\s)@([a-z0-9_-]+)\b/gi)].map((match) => match[1]!.toLowerCase()))
  return members.filter((member) => tokens.has(member.handle.toLowerCase()) || tokens.has(member.sessionId.toLowerCase())).map((member) => member.sessionId)
}

const TAGGED_INTRO = "You were tagged in this message:"
const TAGGED_OUTRO = "This is a crew message. Use your judgment about whether to respond. Keep following your assigned task and the user's instructions."
const NOTICE_INTRO = "A new message is available in your crew's shared chat. Fetch it if useful: "
const NOTICE_OUTRO = "This is an informational notification. No reply or action is required."

export function formatCrewChatDelivery(message: CrewChatMessage, mentioned: boolean, fetchCommand: string, replyCommand: string): string {
  const source = `Crew chat · ${message.author.name} · message ${message.sequence}`
  if (mentioned) return `${source}\n${TAGGED_INTRO}\n\n${message.text}\n\n${TAGGED_OUTRO}\nReply in the shared chat if useful: ${replyCommand}\nFor context: ${fetchCommand}`
  return `${source}\n${NOTICE_INTRO}${fetchCommand}\n${NOTICE_OUTRO}`
}

/** A crew chat message as it reached a member's session, read back from the prompt that carried it. */
export interface CrewChatDeliveryPrompt {
  author: string
  sequence: number
  /** The message when the member was tagged; a notice only announces it. */
  text: string | null
  /** The crew, from the fetch command the prompt carries. */
  rootId: string | null
}

export function isCrewChatDelivery(text: string): boolean {
  return CREW_CHAT_DELIVERY_RE.test(text.trim())
}

export function parseCrewChatDelivery(text: string): CrewChatDeliveryPrompt | null {
  const trimmed = text.trim()
  const source = CREW_CHAT_DELIVERY_RE.exec(trimmed)
  if (!source) return null
  const rest = trimmed.slice(source[0].length)
  const rootId = /cogpit-session chat fetch '([^']+)'/.exec(rest)?.[1] ?? null
  const delivery = { author: source[1]!, sequence: Number(source[2]), rootId }
  if (rest.startsWith(`${TAGGED_INTRO}\n\n`)) {
    const end = rest.lastIndexOf(`\n\n${TAGGED_OUTRO}\n`)
    return end < 0 ? null : { ...delivery, text: rest.slice(TAGGED_INTRO.length + 2, end) }
  }
  return rest.startsWith(NOTICE_INTRO) && rest.endsWith(NOTICE_OUTRO) ? { ...delivery, text: null } : null
}
