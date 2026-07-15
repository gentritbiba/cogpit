function matchScore(lowerPath: string, basename: string, normalized: string): number {
  if (basename === normalized || basename.startsWith(`${normalized}.`)) return 0
  if (basename.startsWith(normalized)) return 1
  if (lowerPath.startsWith(normalized)) return 2
  if (basename.includes(normalized)) return 3
  return 4
}

export function rankProjectFiles(files: string[], query: string, limit: number): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return files.slice(0, limit)
  const terms = normalized.split(/\s+/).filter(Boolean)

  return files
    .map((path) => {
      const lowerPath = path.toLowerCase()
      const basename = lowerPath.split("/").at(-1) ?? lowerPath
      if (!terms.every((term) => lowerPath.includes(term))) return null
      return { path, score: matchScore(lowerPath, basename, normalized), depth: path.split("/").length }
    })
    .filter((entry): entry is { path: string; score: number; depth: number } => entry !== null)
    .sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.length - b.path.length)
    .slice(0, limit)
    .map((entry) => entry.path)
}
