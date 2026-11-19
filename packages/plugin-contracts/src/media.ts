import { z } from "zod"
import { ContractValidationError } from "./json.js"

export const MEDIA_LIMIT_BYTES = 8 * 1024 * 1024
export const audioMimeSchema = z.enum(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/opus", "audio/aac"])
/** The one type a published page is sent as. */
export const HTML_MIME = "text/html"
export interface PluginMedia { mimeType: string; bytes: ArrayBuffer }
export type PluginExecutionResult = import("./json.js").JsonValue | PluginMedia

export function parsePluginMedia(value: unknown): PluginMedia {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2) throw new ContractValidationError([{ path: "$", message: "Invalid media response" }])
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const mimeType = audioMimeSchema.safeParse(descriptors.mimeType?.value)
  const bytes: unknown = descriptors.bytes?.value
  if (!mimeType.success || !(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMIT_BYTES) throw new ContractValidationError([{ path: "$", message: "Invalid or oversized audio response" }])
  return { mimeType: mimeType.data, bytes }
}

/** A request body Cogpit supplies itself: a recording, or a page to publish. */
export function parsePluginUpload(value: unknown): PluginMedia {
  const descriptors = value && typeof value === "object" && Object.keys(value).length === 2 ? Object.getOwnPropertyDescriptors(value) : null
  const bytes: unknown = descriptors?.bytes?.value
  if (descriptors?.mimeType?.value !== HTML_MIME) return parsePluginMedia(value)
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMIT_BYTES) throw new ContractValidationError([{ path: "$", message: "Invalid or oversized page" }])
  return { mimeType: HTML_MIME, bytes }
}
