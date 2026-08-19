import { realpath, stat } from "node:fs/promises"
import { basename, extname, join, relative, sep } from "node:path"

/**
 * Where projects actually keep their icon, in priority order.
 *
 * A project already ships a picture of itself; asking the user to choose one is
 * work they have effectively already done. Root icons win over framework asset
 * directories because a repository that bothers to put one at the top has
 * chosen it deliberately.
 */
export const PROJECT_ICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "icon.svg",
  "icon.png",
  "logo.svg",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "public/logo.svg",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/favicon.svg",
  "src/favicon.ico",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "build/icon.png",
  "build/icon.ico",
  "docs/favicon.ico",
  ".idea/icon.svg",
] as const

/** Extensions worth probing when guessing a mark named after the project. */
const NAMED_ICON_EXTENSIONS = [".svg", ".png", ".ico"] as const

/**
 * Repositories frequently name their mark after themselves — `public/cogpit.svg`
 * rather than `public/favicon.svg`. Probing the project's own name is a cheap
 * stand-in for parsing entry HTML to find the icon it links.
 */
function namedIconCandidates(root: string): string[] {
  const name = basename(root)
  if (!name || name.startsWith(".")) return []
  return ["public", "assets", "static", "."].flatMap((dir) =>
    NAMED_ICON_EXTENSIONS.map((ext) => join(dir, `${name}${ext}`)),
  )
}

/** An icon larger than this is a build artefact or a photograph, not a mark. */
const MAX_ICON_BYTES = 2 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
}

export function iconContentType(path: string): string | null {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? null
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep)
}

/**
 * The project's own icon, or null when it has none.
 *
 * Both the project root and each candidate are canonicalised before they are
 * compared, so a symlink cannot point the icon route at a file outside the
 * project and a caller passing an uncanonical root still gets an answer.
 */
export async function resolveProjectIcon(projectPath: string): Promise<string | null> {
  let root: string
  try {
    root = await realpath(projectPath)
  } catch {
    return null
  }

  // A mark named after the project beats a generic favicon buried in a
  // framework directory, but not one deliberately placed at the root.
  const candidates = [
    ...PROJECT_ICON_CANDIDATES.slice(0, 6),
    ...namedIconCandidates(root),
    ...PROJECT_ICON_CANDIDATES.slice(6),
  ]

  for (const candidate of candidates) {
    const guess = join(root, candidate)
    try {
      const resolved = await realpath(guess)
      if (!isInside(root, resolved)) continue

      const info = await stat(resolved)
      if (!info.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) continue
      if (!iconContentType(resolved)) continue

      return resolved
    } catch {
      // Missing candidate; try the next one.
    }
  }
  return null
}
