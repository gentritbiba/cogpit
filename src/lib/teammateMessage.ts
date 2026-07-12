// Parsing for the <teammate-message> envelope that wraps inter-agent messages.
//
// When the orchestrator (or a team lead) sends a message to a spawned agent,
// the recipient's session records it wrapped like:
//
//   <teammate-message teammate_id="team-lead"> ...markdown body... </teammate-message>
//
// We want to render the inner body as normal markdown (with a small badge
// naming the teammate) instead of dumping the raw XML wrapper — so callers
// unwrap the envelope and keep the inner content.

const TEAMMATE_MESSAGE_RE = /<teammate-message([^>]*)>([\s\S]*?)<\/teammate-message>/g
const TEAMMATE_ID_RE = /teammate_id="([^"]*)"/

export interface ParsedTeammateMessage {
  /** The `teammate_id` attribute of the first envelope, if present. */
  teammateId: string | null
  /** True when at least one <teammate-message> envelope was found. */
  isTeammate: boolean
  /** The text with every envelope unwrapped (tags removed, inner kept). */
  text: string
}

/**
 * Unwrap any <teammate-message> envelopes in `text`, returning the inner
 * content plus the first envelope's teammate id. Non-teammate text passes
 * through unchanged with `isTeammate: false`.
 */
export function parseTeammateMessage(text: string): ParsedTeammateMessage {
  let teammateId: string | null = null
  let isTeammate = false

  const unwrapped = text.replace(TEAMMATE_MESSAGE_RE, (_full, attrs: string, inner: string) => {
    isTeammate = true
    if (teammateId === null) {
      const m = attrs.match(TEAMMATE_ID_RE)
      if (m) teammateId = m[1]
    }
    return inner.trim()
  })

  return { teammateId, isTeammate, text: isTeammate ? unwrapped.trim() : text }
}
