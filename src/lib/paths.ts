// ── Renderer-side host path helpers ─────────────────────────────────────
//
// The renderer receives absolute host paths as opaque strings and has no
// node:path, so these compare and slice the string form. Paths can come from a
// Windows host even when the browser runs elsewhere, hence the drive-letter
// handling.

const WINDOWS_PATH = /^[a-z]:[\\/]/i

/** Collapse separators to "/" (Windows only) and drop any trailing slash. */
function normalize(path: string): string {
  const unified = WINDOWS_PATH.test(path) ? path.replace(/\\/g, "/") : path
  const trimmed = unified.replace(/\/+$/, "")
  return trimmed || "/"
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function comparable(path: string): string {
  const normalized = normalize(path)
  return WINDOWS_PATH.test(path) ? normalized.toLowerCase() : normalized
}

/** The containing directory of `path`, or the path itself when it has none. */
export function parentDirectory(path: string): string {
  const normalized = normalize(path)
  const separator = normalized.lastIndexOf("/")
  if (separator < 0) return normalized
  return separator === 0 ? "/" : normalized.slice(0, separator)
}

/**
 * `path` expressed relative to `root` with "/" separators, or null when it
 * lives outside `root`. An empty string means the two are the same directory.
 */
export function relativePathWithin(root: string, path: string): string | null {
  const comparableRoot = comparable(root)
  const comparablePath = comparable(path)
  if (comparableRoot === comparablePath) return ""
  const prefix = comparableRoot === "/" ? "/" : `${comparableRoot}/`
  if (!comparablePath.startsWith(prefix)) return null
  return normalize(path).slice(prefix.length)
}
