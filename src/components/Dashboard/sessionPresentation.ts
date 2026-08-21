import { truncate } from "@/lib/format"
import type { SessionInfo } from "./types"

/** A transcript touched this recently is treated as still running. */
const LIVE_THRESHOLD_MS = 2 * 60 * 1000

export function isRecentlyActive(timestamp: string | null | undefined): boolean {
  if (!timestamp) return false
  return Date.now() - new Date(timestamp).getTime() < LIVE_THRESHOLD_MS
}

/**
 * Best label for a session row. Teammate sessions open with a message
 * envelope rather than a readable prompt, so their member name wins over it.
 *
 * Deliberately not LiveSessions' `sessionTitle`: this row shows the last
 * prompt on its own line, so the title must not spend it.
 */
export function sessionRowTitle(s: SessionInfo, customName?: string): string {
  const teammateName = s.teamName ? s.agentName : ""
  const label = customName || s.aiTitle || s.name || teammateName || s.slug
    || s.firstUserMessage || s.customTitle
  // A bare session id is a last resort, and only its head is recognisable.
  return label ? truncate(label, 70) : truncate(s.sessionId, 16)
}

/** Comparable form of a label, so a preview that only repeats the title is dropped. */
function previewKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 40).toLowerCase()
}

/**
 * Second line of a session row: the most recent prompt, which says where the
 * session got to rather than where it started.
 */
export function sessionPreviewText(s: SessionInfo, title: string): string | null {
  const preview = (s.lastUserMessage || s.firstUserMessage || "").trim()
  if (!preview) return null
  if (previewKey(preview) === previewKey(title)) return null
  return truncate(preview, 220)
}

export function matchesSessionFilter(s: SessionInfo, query: string): boolean {
  const q = query.toLowerCase()
  return [
    s.aiTitle,
    s.name,
    s.slug,
    s.customTitle,
    s.firstUserMessage,
    s.lastUserMessage,
    s.model,
    s.gitBranch,
    s.agentName,
    s.sessionId,
  ].some((field) => field?.toLowerCase().includes(q))
}
