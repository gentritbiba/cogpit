import { z } from "zod"
import { boundedText } from "./schema.js"

/** An opaque revision of the composer a drafts request applies to; a stale one is refused. */
export const draftTokenSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u)
export const draftIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u)
export const DRAFT_LIMITS = Object.freeze({ page: 20, previewChars: 2000, contextItems: 12, images: 16 })

export const draftPreviewSchema = z.strictObject({
  id: draftIdSchema,
  kind: z.enum(["stash", "sent", "refused"]),
  savedAt: z.string().min(1).max(64),
  /** At most `previewChars` of the saved text; `textChars` is its full length. */
  text: boundedText(DRAFT_LIMITS.previewChars * 4),
  textChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  context: z.array(z.strictObject({ kind: z.enum(["file", "terminal", "quote", "browser"]), label: boundedText(256) })).max(DRAFT_LIMITS.contextItems),
  /** Image metadata only; image bytes never enter a plugin frame. */
  images: z.array(z.strictObject({ mediaType: z.string().min(1).max(64), bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).max(DRAFT_LIMITS.images),
})
export type DraftPreview = z.infer<typeof draftPreviewSchema>

export const draftListSchema = z.strictObject({
  token: draftTokenSchema,
  items: z.array(draftPreviewSchema).max(DRAFT_LIMITS.page),
  next: z.string().min(1).max(128).optional(),
  /** Saving or reading failed; the message says what the user can do. */
  error: boundedText(512).optional(),
  /** Saved data is damaged; it is only reset by `recover("reset")` after a backup. */
  corrupt: z.boolean().optional(),
  /** An image upload was interrupted while the draft was saved. */
  pendingUpload: z.boolean().optional(),
})
export type DraftList = z.infer<typeof draftListSchema>
export const draftCaptureResultSchema = z.strictObject({ id: draftIdSchema })
export type DraftCaptureResult = z.infer<typeof draftCaptureResultSchema>
export const draftRestoreModeSchema = z.enum(["replace", "swap", "merge"])
export type DraftRestoreMode = z.infer<typeof draftRestoreModeSchema>
/** `retry` writes again after a storage failure and retries pending hand-offs; `reset` replaces damaged data and needs a backup first; `dismissUpload` clears an interrupted-upload notice. */
export const draftRecoveryActionSchema = z.enum(["retry", "reset", "dismissUpload"])
export type DraftRecoveryAction = z.infer<typeof draftRecoveryActionSchema>

export const draftParamsSchemas = {
  "drafts.list": z.strictObject({ cursor: z.string().min(1).max(128).optional() }),
  "drafts.capture": z.strictObject({ token: draftTokenSchema, clear: z.boolean() }),
  "drafts.restore": z.strictObject({ token: draftTokenSchema, id: draftIdSchema, mode: draftRestoreModeSchema }),
  "drafts.remove": z.strictObject({ id: draftIdSchema }),
  "drafts.backup": z.strictObject({}),
  "drafts.recover": z.strictObject({ action: draftRecoveryActionSchema }),
} as const

export interface DraftMethodMap {
  "drafts.list": { params: { cursor?: string }; result: DraftList }
  "drafts.capture": { params: { token: string; clear: boolean }; result: DraftCaptureResult }
  "drafts.restore": { params: { token: string; id: string; mode: DraftRestoreMode }; result: null }
  "drafts.remove": { params: { id: string }; result: null }
  "drafts.backup": { params: Record<string, never>; result: null }
  "drafts.recover": { params: { action: DraftRecoveryAction }; result: null }
}
export type DraftMethod = keyof DraftMethodMap
export const DRAFT_METHODS = Object.freeze(Object.keys(draftParamsSchemas) as DraftMethod[])
export const isDraftMethod = (method: string): method is DraftMethod => (DRAFT_METHODS as readonly string[]).includes(method)
