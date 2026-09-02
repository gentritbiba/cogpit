import { authFetch } from "../auth"

/**
 * Undo for an agent whose CLI rewinds its own history — Copilot's
 * `session.history.rewind` — where Cogpit never truncates the transcript or
 * replays edits itself. Gated by `capabilities.nativeRewind`.
 */

export type NativeRewindMode = "conversation" | "conversation-and-files"

export interface NativeRewindPreview {
  available?: boolean
  fileCount?: number
  files?: Array<{ path?: string }>
}

/** What rewinding to `eventId` would touch, or null when the CLI cannot say. */
export async function previewNativeRewind(
  sessionId: string,
  eventId: string,
): Promise<NativeRewindPreview | null> {
  const response = await authFetch(
    `/api/copilot-history/${encodeURIComponent(sessionId)}/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
    },
  )
  return response.ok ? await response.json() as NativeRewindPreview : null
}

/** Rewind to `eventId`; `error` carries the CLI's own reason when it refuses. */
export async function applyNativeRewind(
  sessionId: string,
  eventId: string,
  mode: NativeRewindMode,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await authFetch(
    `/api/copilot-history/${encodeURIComponent(sessionId)}/rewind`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, mode }),
    },
  )
  const result = await response.json().catch(() => null) as {
    outcome?: string
    error?: string
  } | null
  if (!response.ok || result?.outcome !== "success") {
    return {
      ok: false,
      error: result?.error || `Copilot rewind failed${result?.outcome ? `: ${result.outcome}` : ""}`,
    }
  }
  return { ok: true }
}
