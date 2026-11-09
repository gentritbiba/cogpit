import { searchSessionMessages } from "../helpers"

interface Outcome {
  mtimeMs: number
  size: number
  found: string | null
}

/** The searches remembered, most recent last; typing a query walks through several. */
const MAX_QUERIES = 16
const outcomes = new Map<string, Map<string, Outcome>>()

interface SearchedFile {
  filePath: string
  mtimeMs: number
  size: number
}

function remembered(query: string): Map<string, Outcome> {
  let byFile = outcomes.get(query)
  if (byFile) outcomes.delete(query)
  else byFile = new Map()
  outcomes.set(query, byFile)
  if (outcomes.size > MAX_QUERIES) outcomes.delete(outcomes.keys().next().value!)
  return byFile
}

const unchanged = (outcome: Outcome | undefined, file: SearchedFile): outcome is Outcome =>
  outcome !== undefined && outcome.mtimeMs === file.mtimeMs && outcome.size === file.size

/**
 * `searchSessionMessages`, read again only once the transcript changed. A
 * transcript where a shorter query found nothing holds no longer one either.
 */
export async function searchTranscript(file: SearchedFile, query: string): Promise<string | null> {
  const byFile = remembered(query)
  const known = byFile.get(file.filePath)
  if (unchanged(known, file)) return known.found
  const lower = query.toLowerCase()
  for (const [other, otherByFile] of outcomes) {
    if (other === query || !lower.includes(other.toLowerCase())) continue
    const outcome = otherByFile.get(file.filePath)
    if (unchanged(outcome, file) && outcome.found === null) {
      byFile.set(file.filePath, outcome)
      return null
    }
  }
  const found = await searchSessionMessages(file.filePath, query)
  byFile.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size, found })
  return found
}

export function __resetSearchMemoForTest(): void {
  outcomes.clear()
}
