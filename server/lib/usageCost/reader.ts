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
import { createUsageScanner, type UsageCostRecord } from "../../agents/usageScanners"

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
  const scanner = createUsageScanner(provider, filePath)

  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    })

    for await (const line of lines) {
      if (!scanner.wantsLine(line)) continue
      records.push(...scanner.accept(line))
    }
  } catch {
    return null
  }

  return records
}

/**
 * Within-file de-duplication, applied before an entry is cached.
 *
 * Siblings sharing a key repeat one message's usage, so they must collapse to a
 * single record — but they are not identical. The input and cache counts are
 * final from the first block, while `output_tokens` is a running total that
 * only settles on the last one, so the largest output wins.
 */
export function dedupeWithinFile(records: UsageCostRecord[]): UsageCostRecord[] {
  const slotByKey = new Map<string, number>()
  const kept: UsageCostRecord[] = []
  for (const record of records) {
    if (record.dedupeKey === null) {
      kept.push(record)
      continue
    }
    const slot = slotByKey.get(record.dedupeKey)
    if (slot === undefined) {
      slotByKey.set(record.dedupeKey, kept.push(record) - 1)
      continue
    }
    if (record.totals.outputTokens > kept[slot].totals.outputTokens) kept[slot] = record
  }
  return kept
}
