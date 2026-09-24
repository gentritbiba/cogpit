import { isRecord } from "../../shared/objects"
import type { ImageAttachment } from "../agents/runtimes"
import { ErrorCodes, RouteError } from "../lib/routeError"

function isImageAttachment(value: unknown): value is ImageAttachment {
  return isRecord(value)
    && typeof value.data === "string" && value.data !== "" && !value.data.startsWith("data:")
    && typeof value.mediaType === "string" && value.mediaType !== ""
}

/**
 * Why a request's images cannot be sent, or null when they can: each must be
 * base64 bytes beside a media type, as every agent delivers them. An agent
 * that fills in a missing type, or passes a data URL on whole, would deliver
 * bytes the prompt's audit digest does not describe.
 */
export function imagesRefusal(images: unknown): RouteError | null {
  if (images == null || (Array.isArray(images) && images.every(isImageAttachment))) return null
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, "images must each hold base64 data and a mediaType")
}
