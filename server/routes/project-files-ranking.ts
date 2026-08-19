function matchScore(lowerPath: string, basename: string, normalized: string): number {
  if (basename === normalized || basename.startsWith(`${normalized}.`)) return 0
  if (basename.startsWith(normalized)) return 1
  if (lowerPath.startsWith(normalized)) return 2
  if (basename.includes(normalized)) return 3
  return 4
}

export interface RankedProjectFiles {
  /** The highest-ranked matches, capped at `limit`. */
  files: string[]
  /** How many files matched before `limit` was applied. */
  totalMatches: number
}

export function rankProjectFiles(files: string[], query: string, limit: number): RankedProjectFiles {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return { files: files.slice(0, limit), totalMatches: files.length }
  const terms = normalized.split(/\s+/).filter(Boolean)

  const matches = files
    .map((path) => {
      const lowerPath = path.toLowerCase()
      const basename = lowerPath.split("/").at(-1) ?? lowerPath
      if (!terms.every((term) => lowerPath.includes(term))) return null
      return { path, score: matchScore(lowerPath, basename, normalized), depth: path.split("/").length }
    })
    .filter((entry): entry is { path: string; score: number; depth: number } => entry !== null)
    .sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.length - b.path.length)

  return { files: matches.slice(0, limit).map((entry) => entry.path), totalMatches: matches.length }
}
