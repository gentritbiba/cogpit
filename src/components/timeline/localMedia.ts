import { authUrl } from "@/lib/auth"
import { IMAGE_TYPES, VIDEO_TYPES } from "../../../shared/mediaTypes"

export const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_TYPES))
export const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_TYPES))

function hasExtensionIn(path: string | undefined, extensions: Set<string>): boolean {
  if (!path) return false
  const dot = path.lastIndexOf(".")
  return dot !== -1 && extensions.has(path.slice(dot).toLowerCase())
}

function hasImageExtension(path: string | undefined): boolean {
  return hasExtensionIn(path, IMAGE_EXTENSIONS)
}

export function hasVideoExtension(path: string | undefined): boolean {
  return hasExtensionIn(path, VIDEO_EXTENSIONS)
}

/** True for an absolute filesystem path, as opposed to a web or data URL. */
function isLocalPath(src: string | undefined): src is string {
  if (!src) return false
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return false
  return src.startsWith("/")
}

export function isLocalImagePath(src: string | undefined): src is string {
  return isLocalPath(src) && hasImageExtension(src)
}

export function isLocalVideoPath(src: string | undefined): src is string {
  return isLocalPath(src) && hasVideoExtension(src)
}

/**
 * Rewrite local media paths to go through the API proxy. `authUrl` applies the
 * active device prefix and appends the auth token for remote clients, which
 * also routes the request to the active device via the hub proxy. Only the
 * proxy URL is wrapped; external/data URLs pass through untouched so the token
 * is never leaked to a third-party host.
 */
export function resolveMediaSrc(src: string | undefined): string | undefined {
  if (isLocalImagePath(src) || isLocalVideoPath(src)) {
    return authUrl(`/api/local-file?path=${encodeURIComponent(src)}`)
  }
  return src
}
