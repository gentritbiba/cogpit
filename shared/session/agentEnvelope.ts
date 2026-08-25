// Parsing for the envelopes that wrap inter-agent messages.
//
// Current Claude Code writes structured `attachment.origin` metadata alongside
// the envelope, so turnBuilder reads that first. This regex path exists for
// records written before `origin` — and for the queue-operation copy, which
// carries the raw text and nothing else.
//
//   <agent-message from="worker-name"> ...markdown body... </agent-message>
//   <teammate-message teammate_id="team-lead"> ...markdown body... </teammate-message>

const ENVELOPE_RE = /<(agent-message|teammate-message)([^>]*)>([\s\S]*?)<\/\1>/g
const SENDER_RE = /(?:\bfrom|\bteammate_id)="([^"]*)"/

export interface ParsedAgentEnvelope {
  /** Sender named by the first envelope, or null when there is none. */
  sender: string | null
  /** Text with every envelope unwrapped. Unchanged when no envelope matched. */
  body: string
}

export function parseAgentEnvelope(text: string): ParsedAgentEnvelope {
  let sender: string | null = null
  let matched = false

  const unwrapped = text.replace(ENVELOPE_RE, (_full, _tag: string, attrs: string, inner: string) => {
    matched = true
    if (sender === null) {
      const m = attrs.match(SENDER_RE)
      if (m?.[1]) sender = m[1]
    }
    return inner.trim()
  })

  return matched ? { sender, body: unwrapped.trim() } : { sender: null, body: text }
}

/** Phrases that announce a question up front, checked against the opening. */
const ASK_PHRASES = [
  "blocking question",
  "before i touch",
  "should i",
  "tell me one of",
  "let me know",
  "your call",
  "who owns",
  "confirm whether",
]

const LEAD_CHARS = 200
/** Questions land at the end of a report; only the tail counts for "?". */
const TAIL_FRACTION = 0.75

/**
 * Whether a message reads as asking the reader for something.
 *
 * This is the one guessed signal in agent mail, so callers must gate it on the
 * message also being unanswered — a false positive then disappears as soon as
 * the reader replies, and can never go stale on screen.
 */
export function looksLikeQuestion(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false

  const lower = trimmed.toLowerCase()
  if (ASK_PHRASES.some((phrase) => lower.slice(0, LEAD_CHARS).includes(phrase))) return true

  return trimmed.slice(Math.floor(trimmed.length * TAIL_FRACTION)).includes("?")
}
