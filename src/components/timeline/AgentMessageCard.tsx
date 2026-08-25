import { memo, useMemo, useState, type CSSProperties } from "react"
import { ArrowDownLeft, ChevronDown, ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useElapsedTimer } from "@/hooks/useElapsedTimer"
import { formatDuration } from "@/lib/format"
import { WORKING_STATUSES } from "@/lib/sessionActivity"
import { looksLikeQuestion } from "../../../shared/session/agentEnvelope"

/**
 * Hues spread around the wheel so two agents in the same session rarely land on
 * neighbouring colours. Lightness and chroma are fixed by the card so the accent
 * keeps its contrast on both the light theme and the pure-black OLED one.
 */
const ACCENT_HUES = [20, 50, 80, 110, 140, 170, 200, 230, 260, 290, 320, 350]

/** Stable per-sender hue: the same agent is the same colour session-wide. */
export function agentAccentHue(sender: string): number {
  let hash = 2166136261
  for (let i = 0; i < sender.length; i++) {
    hash ^= sender.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return ACCENT_HUES[(hash >>> 0) % ACCENT_HUES.length]
}

/**
 * Markdown reduced to prose, for the collapsed teaser only. The teaser is
 * clamped by CSS, and a clamp can land anywhere — including inside what would
 * have been a code fence — so nothing here may stay markup.
 */
export function flattenToPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false

  for (const rawLine of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence
      continue
    }

    let line = rawLine
    if (!inFence) {
      line = line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue
      line = line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
        .replace(/(?<![\w*])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\w*])/g, "$1")
        .replace(/`+/g, "")
    }

    const trimmed = line.trim()
    if (trimmed) out.push(trimmed)
  }

  return out.join(" ")
}

function splitSubjectAndPreview(body: string): { subject: string; preview: string } {
  const lines = body.split("\n")
  let first = 0
  while (first < lines.length && lines[first].trim() === "") first++

  const subject = flattenToPlainText(lines[first] ?? "")
  if (!subject) return { subject: flattenToPlainText(body), preview: "" }

  return { subject, preview: flattenToPlainText(lines.slice(first + 1).join("\n")) }
}

function parseTime(timestamp: string | undefined): number | null {
  if (!timestamp) return null
  const ms = new Date(timestamp).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Gap between two records, or null when either end is unusable or out of order. */
function elapsedBetween(from: number | null, to: number | null): number | null {
  if (from === null || to === null || to < from) return null
  return to - from
}

function formatTime(timestamp: string | undefined): string | null {
  const ms = parseTime(timestamp)
  return ms === null ? null : new Date(ms).toLocaleTimeString()
}

/**
 * Whether the sender is working right now, when — and only when — the name
 * resolves to exactly one live session.
 *
 * Agent names are unique inside a team but not across them, and no inventory is
 * mounted at all outside a device root. Every one of those cases returns null,
 * because a dot that might be pointing at the wrong session is worse than no
 * dot: an indicator that is usually meaningless trains you to ignore the one
 * time it matters.
 */
function useSenderLiveness(sender: string): "working" | "idle" | null {
  const sessions = useSessionInventoryOptional()?.sessions

  return useMemo(() => {
    if (!sender || !sessions) return null
    const matches = sessions.filter((session) => session.agentName === sender)
    if (matches.length !== 1) return null
    const status = matches[0].agentStatus
    if (!status) return null
    return WORKING_STATUSES.has(status) ? "working" : "idle"
  }, [sender, sessions])
}

interface Props {
  sender: string
  body: string
  timestamp?: string
  /** Filled by the pairing pass; rendered by the reply footer. */
  reply?: { summary: string; timestamp: string }
  /** Whether this session is still live, so an unanswered message is still waiting. */
  isLive?: boolean
}

/**
 * A message another agent sent into this session, rendered as mail: who sent it,
 * what it is about, and a teaser, with the full body one click away.
 */
export const AgentMessageCard = memo(function AgentMessageCard({
  sender,
  body,
  timestamp,
  reply,
  isLive,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const { subject, preview } = useMemo(() => splitSubjectAndPreview(body), [body])
  const time = formatTime(timestamp)
  const liveness = useSenderLiveness(sender)
  const accent = "text-[oklch(0.52_0.16_var(--agent-hue))] dark:text-[oklch(0.74_0.14_var(--agent-hue))]"

  // The one guessed signal on this card, so it is gated on the message also
  // being unanswered: a false positive erases itself the moment you reply, and
  // can never sit on screen going stale.
  const isQuestion = useMemo(() => looksLikeQuestion(body), [body])
  const needsYou = isQuestion && !reply

  const askedAt = parseTime(timestamp)
  const replyDelay = reply ? elapsedBetween(askedAt, parseTime(reply.timestamp)) : null
  const awaiting = !reply && isLive === true
  // Only pumps a re-render each second; the wait itself is measured from the
  // message, so it survives a card that mounted long after the message arrived.
  useElapsedTimer(awaiting)

  return (
    <div
      data-agent-rail
      style={{ "--agent-hue": String(agentAccentHue(sender)) } as CSSProperties}
      className="my-2 rounded-lg border border-l-[3px] border-border bg-card px-3 py-2 [border-left-color:oklch(0.52_0.16_var(--agent-hue))] dark:[border-left-color:oklch(0.74_0.14_var(--agent-hue))]"
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ArrowDownLeft className={`size-3.5 shrink-0 ${accent}`} data-icon="inline-start" />
          <span className={`truncate font-mono text-xs font-medium ${accent}`}>{sender}</span>
          {liveness && (
            <span
              data-testid="agent-liveness"
              data-live={liveness}
              title={liveness === "working" ? `${sender} is working now` : `${sender} is idle`}
              className={`inline-flex size-1.5 shrink-0 rounded-full ${
                liveness === "working" ? "animate-pulse bg-warning" : "bg-success"
              }`}
            />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {needsYou && (
            <Badge
              variant="outline"
              className="h-4 border-warning/30 bg-warning/10 px-1.5 text-[10px] tracking-wide text-warning uppercase"
            >
              Needs you
            </Badge>
          )}
          {time && <span className="text-xs text-muted-foreground">{time}</span>}
        </div>
      </div>

      {expanded ? (
        <div
          data-testid="agent-message-body"
          className="mt-1.5 max-w-none overflow-hidden break-words text-sm leading-relaxed"
        >
          <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
            {body}
          </ReactMarkdown>
        </div>
      ) : (
        <>
          <p
            data-testid="agent-message-subject"
            className="mt-1 line-clamp-2 break-words text-sm font-medium text-foreground"
          >
            {subject}
          </p>
          {preview && (
            <p
              data-testid="agent-message-preview"
              className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground"
            >
              {preview}
            </p>
          )}
        </>
      )}

      <div className="mt-1.5 flex items-center justify-end gap-2">
        <p
          data-testid="agent-message-state"
          className={`min-w-0 flex-1 truncate text-xs ${awaiting ? "text-warning" : "text-muted-foreground"}`}
        >
          {reply ? (
            <>
              {replyDelay === null ? "You replied" : `You replied ${formatDuration(replyDelay)} later`}
              {reply.summary && ` \u00b7 "${reply.summary}"`}
            </>
          ) : awaiting ? (
            askedAt === null
              ? "Awaiting your reply"
              : `Awaiting your reply \u00b7 ${formatDuration(Math.max(0, Date.now() - askedAt))}`
          ) : (
            "Never answered"
          )}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((open) => !open)}
          className="-mr-2 text-muted-foreground"
        >
          {expanded ? (
            <>
              <ChevronDown data-icon="inline-start" /> Collapse
            </>
          ) : (
            <>
              <ChevronRight data-icon="inline-start" /> Expand ·{" "}
              {body.length.toLocaleString("en-US")} {body.length === 1 ? "char" : "chars"}
            </>
          )}
        </Button>
      </div>
    </div>
  )
})
