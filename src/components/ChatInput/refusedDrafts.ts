import { deviceScopedKey } from "@/lib/device"
import type { UploadedImage } from "./useImageUpload"

/** A message a session refused, as the composer held it. */
export interface RefusedDraft {
  text: string
  images: UploadedImage[]
}

/**
 * Refused messages whose composer went away or moved on to another session,
 * by session. An access refusal takes the composer with it (a read-only notice
 * or leaving the session), so the message waits here for the next empty
 * composer that shows its session. In memory only, per device and signed-in
 * user.
 */
const drafts = new Map<string, RefusedDraft>()

function draftKey(sessionId: string): string {
  return `${deviceScopedKey("refused-draft")}::${sessionId}`
}

export function keepRefusedDraft(sessionId: string, draft: RefusedDraft): void {
  drafts.set(draftKey(sessionId), draft)
}

/** The session's refused message, which leaves the store. */
export function takeRefusedDraft(sessionId: string): RefusedDraft | undefined {
  const key = draftKey(sessionId)
  const draft = drafts.get(key)
  drafts.delete(key)
  return draft
}
