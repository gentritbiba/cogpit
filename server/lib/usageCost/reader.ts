/**
 * Filesystem access for transcript scanning: directory walking with an mtime
 * prefilter, and streaming line-at-a-time parsing so large transcripts are
 * never materialised.
 */
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { UsageCostProvider } from "../../../shared/contracts/usageCost"
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeUsageLine,
  parseCodexUsageLine,
  type UsageCostRecord,
} from "./transcripts"

export interface TranscriptFile {
  path: string
  size: number
  mtimeMs: number
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 * Errors on individual entries are swallowed: session files rotate and vanish
 * mid-walk, and a partial listing beats failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!entry.name.endsWith(".jsonl")) continue
      try {
        const stats = await stat(child)
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs })
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }

  await walk(root)
  return found
}

/**
 * Streams one transcript and returns its usage records, or null when the file
 * could not be read. The distinction matters to the caller's cache: an empty
 * transcript is a stable fact worth memoising, while a transient read failure
 * memoised under the same `(size, mtime)` key would silently drop that file's
 * usage until it next changes.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageCostProvider,
): Promise<UsageCostRecord[] | null> {
  const records: UsageCostRecord[] = []
  const codexState = initialCodexScanState()

  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    })

    for await (const line of lines) {
      if (provider === "codex") {
        // Codex carries the active model on turn_context lines that hold no
        // usage of their own, so those still pass through the reducer.
        if (
          !mightCarryUsage(line, provider)
          && !line.includes('"turn_context"')
          && !line.includes('"session_meta"')
        ) {
          continue
        }
        const record = parseCodexUsageLine(line, codexState)
        if (record !== null) records.push(record)
        continue
      }

      if (!mightCarryUsage(line, provider)) continue
      const record = parseClaudeUsageLine(line)
      if (record !== null) records.push(record)
    }
  } catch {
    return null
  }

  return records
}

/** Within-file de-duplication, applied before an entry is cached. */
export function dedupeWithinFile(records: UsageCostRecord[]): UsageCostRecord[] {
  const seen = new Set<string>()
  const kept: UsageCostRecord[] = []
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue
      seen.add(record.dedupeKey)
    }
    kept.push(record)
  }
  return kept
}
