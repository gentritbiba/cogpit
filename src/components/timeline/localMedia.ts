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

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

/**
 * The absolute filesystem path `src` names, or null for a web or data URL.
 * Markdown percent-encodes spaces and backslashes, and `remarkLocalPaths`
 * writes Windows paths as `/C:/…`, so both are undone here.
 */
export function localFilePath(src: string | undefined): string | null {
  if (!src || src.startsWith("//")) return null
  let path = src
  try {
    path = decodeURIComponent(src)
  } catch { /* a literal % in a raw path */ }
  if (path.startsWith("/") && WINDOWS_DRIVE_PATH.test(path.slice(1))) return path.slice(1)
  return path.startsWith("/") || WINDOWS_DRIVE_PATH.test(path) ? path : null
}

export function isLocalImagePath(src: string | undefined): src is string {
  return localFilePath(src) !== null && hasImageExtension(src)
}

export function isLocalVideoPath(src: string | undefined): src is string {
  return localFilePath(src) !== null && hasVideoExtension(src)
}

interface UrlNode {
  type: string
  url?: string
  children?: UrlNode[]
}

/**
 * react-markdown drops any URL whose scheme it does not trust, and reads
 * `C:\…` as the scheme `c:`. Rewriting Windows paths and `file://` URLs to
 * `/C:/…` or `/tmp/…` keeps them, and `localFilePath` reads them back.
 */
export function remarkLocalPaths() {
  return (tree: UrlNode) => { rewriteUrls(tree) }
}

function rewriteUrls(node: UrlNode): void {
  if (typeof node.url === "string") node.url = markdownSafeLocalUrl(node.url)
  node.children?.forEach(rewriteUrls)
}

function markdownSafeLocalUrl(url: string): string {
  if (/^file:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      return parsed.pathname + parsed.hash
    } catch {
      return url
    }
  }
  return /^[a-z]:(?:[\\/]|%5c)/i.test(url) ? `/${url}` : url
}

/**
 * Rewrite local media paths to go through the API proxy. `authUrl` applies the
 * active device prefix and appends the auth token for remote clients, which
 * also routes the request to the active device via the hub proxy. Only the
 * proxy URL is wrapped; external/data URLs pass through untouched so the token
 * is never leaked to a third-party host.
 */
export function resolveMediaSrc(src: string | undefined): string | undefined {
  const path = localFilePath(src)
  if (path && (hasImageExtension(path) || hasVideoExtension(path))) {
    return authUrl(`/api/local-file?path=${encodeURIComponent(path)}`)
  }
  return src
}
