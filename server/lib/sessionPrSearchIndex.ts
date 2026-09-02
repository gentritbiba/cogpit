import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { dirs } from "../sessionPaths"
import {
  getCompleteSessionPullRequestData,
  type SessionPullRequestData,
} from "./sessionPrIndex"

interface SessionFileCandidate {
  filePath: string
  size: number
  mtimeMs: number
}

interface IndexEntry extends SessionPullRequestData {
  size: number
  mtimeMs: number
}

interface PersistedIndex {
  version: 1
  entries: Array<[string, IndexEntry]>
}

export interface SessionPrSearchSnapshot {
  byFile: ReadonlyMap<string, SessionPullRequestData>
  pending: number
  total: number
}

const INDEX_FILE = "pr-search-index.json"
const PERSIST_EVERY = 50

let activeIndexPath = ""
let generation = 0
let loaded = false
let loading: Promise<void> | null = null
let indexing = false
let entries = new Map<string, IndexEntry>()
let queue = new Map<string, SessionFileCandidate>()

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Partial<IndexEntry>
  return typeof entry.size === "number"
    && typeof entry.mtimeMs === "number"
    && Array.isArray(entry.pullRequests)
    && Array.isArray(entry.references)
}

function currentIndexPath(): string {
  return join(dirs.SESSION_CONFIG_DIR, INDEX_FILE)
}

function resetForPath(indexPath: string) {
  activeIndexPath = indexPath
  generation += 1
  loaded = false
  loading = null
  indexing = false
  entries = new Map()
  queue = new Map()
}

async function loadIndex(): Promise<void> {
  const indexPath = currentIndexPath()
  if (activeIndexPath !== indexPath) resetForPath(indexPath)
  if (loaded) return
  if (loading) return loading

  const expectedGeneration = generation
  const pendingLoad = readFile(indexPath, "utf-8")
    .then((raw) => {
      if (expectedGeneration !== generation) return
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null) return
      const candidate = parsed as Partial<PersistedIndex>
      if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return
      entries = new Map(candidate.entries.filter(
        (item): item is [string, IndexEntry] => (
          Array.isArray(item) && typeof item[0] === "string" && isIndexEntry(item[1])
        ),
      ))
    })
    .catch(() => undefined)
    .finally(() => {
      if (expectedGeneration === generation) {
        loaded = true
        loading = null
      }
    })
  loading = pendingLoad
  return pendingLoad
}

async function persistIndex(expectedGeneration: number): Promise<void> {
  if (expectedGeneration !== generation || !activeIndexPath) return
  await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
  const payload: PersistedIndex = { version: 1, entries: [...entries] }
  await writeOwnerOnlyJson(activeIndexPath, payload)
}

function entryIsCurrent(entry: IndexEntry | undefined, candidate: SessionFileCandidate): boolean {
  return entry?.size === candidate.size && entry.mtimeMs === candidate.mtimeMs
}

async function runQueue(expectedGeneration: number): Promise<void> {
  let sincePersist = 0
  try {
    while (expectedGeneration === generation && queue.size > 0) {
      const next = queue.entries().next().value as [string, SessionFileCandidate] | undefined
      if (!next) break
      const [filePath, candidate] = next
      queue.delete(filePath)
      if (entryIsCurrent(entries.get(filePath), candidate)) continue

      const data = await getCompleteSessionPullRequestData(filePath, candidate.size)
      if (expectedGeneration !== generation) return
      entries.set(filePath, { ...data, size: candidate.size, mtimeMs: candidate.mtimeMs })
      sincePersist += 1
      if (sincePersist >= PERSIST_EVERY) {
        await persistIndex(expectedGeneration).catch(() => undefined)
        sincePersist = 0
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (sincePersist > 0) await persistIndex(expectedGeneration).catch(() => undefined)
  } finally {
    if (expectedGeneration === generation) {
      indexing = false
      if (queue.size > 0) startIndexing()
    }
  }
}

function startIndexing() {
  if (indexing || queue.size === 0) return
  indexing = true
  const expectedGeneration = generation
  void runQueue(expectedGeneration).catch(() => {
    if (expectedGeneration === generation) indexing = false
  })
}

/**
 * Returns the current durable PR index and schedules stale files in the
 * background. Requests stay short; clients poll while `pending` is non-zero.
 */
export async function getSessionPrSearchSnapshot(
  candidates: SessionFileCandidate[],
): Promise<SessionPrSearchSnapshot> {
  await loadIndex()

  const byFile = new Map<string, SessionPullRequestData>()
  for (const candidate of candidates) {
    const entry = entries.get(candidate.filePath)
    if (entry && entryIsCurrent(entry, candidate)) {
      byFile.set(candidate.filePath, {
        pullRequests: entry.pullRequests,
        references: entry.references,
      })
    } else {
      queue.set(candidate.filePath, candidate)
    }
  }
  startIndexing()

  return {
    byFile,
    pending: candidates.length - byFile.size,
    total: candidates.length,
  }
}

/** Test helper. */
export function resetSessionPrSearchIndex(): void {
  resetForPath("")
}
