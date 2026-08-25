// Parsing for the envelopes that wrap inter-agent messages.
//
// Current Claude Code writes structured `attachment.origin` metadata alongside
// the envelope, so turnBuilder reads that first. This regex path exists for
// records written before `origin` — and for the queue-operation copy, which
// carries the raw text and nothing else.
//
//   <agent-message from="worker-name"> ...markdown body... </agent-message>
//   <teammate-message teammate_id="team-lead"> ...markdown body... </teammate-message>
//
// Known limitation: a nested or quoted envelope leaks the inner raw tags into
// the body, because the lazy body group stops at the first closing tag —
// `<agent-message from="a">outer <agent-message from="b">inner</agent-message>`
// unwraps at the inner closing tag and leaves the trailing `</agent-message>`
// behind. Neither Claude Code nor the queue writes nested envelopes today.

const ENVELOPE_RE = /<(agent-message|teammate-message)([^>]*)>([\s\S]*?)<\/\1>/g

// Tried in order, because an envelope can carry both attributes and
// `teammate_id` is the more specific one. A single alternation cannot express
// that preference: the engine returns the leftmost match, so `from="x"` would
// win purely on attribute order.
const SENDER_PATTERNS = [
  /\bteammate_id=(?:"([^"]*)"|'([^']*)')/,
  /\bfrom=(?:"([^"]*)"|'([^']*)')/,
]

export interface ParsedAgentEnvelope {
  /** Sender named by the first envelope that names one, or null when none does. */
  sender: string | null
  /** True when at least one envelope was unwrapped, even if it named no sender. */
  matched: boolean
  /** Text with every envelope unwrapped. Unchanged when no envelope matched. */
  body: string
}

function readSender(attrs: string): string | null {
  for (const pattern of SENDER_PATTERNS) {
    const m = attrs.match(pattern)
    const value = m?.[1] ?? m?.[2]
    if (value) return value
  }
  return null
}

/**
 * Removes envelope framing that wraps a body — an envelope no reader unwrapped,
 * or the trailing tag the nested case above leaves behind. Only the wrapper
 * goes: a tag quoted inside the body is content, and stays.
 */
export function stripEnvelopeFraming(body: string): string {
  return body
    .replace(/^\s*<(?:agent-message|teammate-message)\b[^>]*>/, "")
    .replace(/<\/(?:agent-message|teammate-message)>\s*$/, "")
    .trim()
}

export function parseAgentEnvelope(text: string): ParsedAgentEnvelope {
  let sender: string | null = null
  let matched = false

  const unwrapped = text.replace(ENVELOPE_RE, (_full, _tag: string, attrs: string, inner: string) => {
    matched = true
    if (sender === null) sender = readSender(attrs)
    return inner.trim()
  })

  return { sender, matched, body: matched ? unwrapped.trim() : text }
}

/**
 * Phrases that announce a question up front, checked against the opening.
 *
 * Derived from a two-message sample and never tuned against real traffic —
 * treat the list as a starting guess, not a validated signal. Word boundaries
 * matter: an unanchored `should i` also fires on `should include`,
 * `should identify`, and `should ignore`, all of which open status reports.
 */
const ASK_PATTERNS = [
  /\bblocking question\b/,
  /\bbefore i touch\b/,
  /\bshould i\b/,
  /\btell me one of\b/,
  /\byour call\b/,
  /\bwho owns\b/,
  /\bconfirm whether\b/,
]

/**
 * Requests the closing line puts to the reader, for the message that asks you to
 * choose without ever typing a `?`. Only in imperative position: that is what
 * separates ", tell me and I'll chain it" from "the logs tell me nothing", and
 * it is why "let me know if you want X" — an offer, not a request — stays out.
 */
const REQUEST_PATTERNS = [
  /(?:^|[,;:.!?—–-]\s*)tell me\b/,
  /(?:^|[,;:.!?—–-]\s*)say so\b/,
]

const LEAD_CHARS = 200
/**
 * Questions land at the end of a report, so only its closing line counts —
 * scoped to the line, not to the last quarter of the body, because a quarter of
 * a long report reaches back far enough to catch a question the report itself
 * quoted and then answered.
 */
const TAIL_CHARS = 200
const URL_RE = /\bhttps?:\/\/\S+/g

/**
 * Whether a message reads as asking the reader for something: announced in the
 * opening, or left on the closing line as a `?` or a request.
 *
 * This is the one guessed signal in agent mail, so callers must gate it on the
 * message also being unanswered — a false positive then disappears as soon as
 * the reader replies, and can never go stale on screen.
 */
export function looksLikeQuestion(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false

  const lead = trimmed.slice(0, LEAD_CHARS).toLowerCase()
  if (ASK_PATTERNS.some((pattern) => pattern.test(lead))) return true

  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1)
  const closing = lastLine.slice(-TAIL_CHARS).replace(URL_RE, "").toLowerCase()
  return closing.includes("?") || REQUEST_PATTERNS.some((pattern) => pattern.test(closing))
}
