import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { dirs } from "../sessionPaths"
import { PR_SEARCH_INDEX_FILE } from "./sessionConfigDir"
import { markCatalogChanged } from "../sessionCatalog/changes"
import {
  getCompleteSessionPullRequestData,
  setCompletedPullRequestLookup,
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

/** Bumped whenever the scanner learns a transcript shape, so cached misses are scanned again. */
const INDEX_VERSION = 2

interface PersistedIndex {
  version: typeof INDEX_VERSION
  entries: Array<[string, IndexEntry]>
}

export interface SessionPrSearchSnapshot {
  byFile: ReadonlyMap<string, SessionPullRequestData>
  pending: number
  total: number
}

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
  return join(dirs.SESSION_CONFIG_DIR, PR_SEARCH_INDEX_FILE)
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
      if (candidate.version !== INDEX_VERSION || !Array.isArray(candidate.entries)) return
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
  const payload: PersistedIndex = { version: INDEX_VERSION, entries: [...entries] }
  await writeOwnerOnlyJson(activeIndexPath, payload)
}

function entryIsCurrent(entry: IndexEntry | undefined, candidate: SessionFileCandidate): boolean {
  return entry?.size === candidate.size && entry.mtimeMs === candidate.mtimeMs
}

function newestQueued(): SessionFileCandidate {
  let newest: SessionFileCandidate | null = null
  for (const candidate of queue.values()) if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate
  return newest!
}

function samePullRequests(previous: IndexEntry | undefined, next: SessionPullRequestData): boolean {
  return JSON.stringify(previous?.pullRequests ?? []) === JSON.stringify(next.pullRequests)
}

async function runQueue(expectedGeneration: number): Promise<void> {
  let sincePersist = 0
  try {
    while (expectedGeneration === generation && queue.size > 0) {
      const candidate = newestQueued()
      const { filePath } = candidate
      queue.delete(filePath)
      const previous = entries.get(filePath)
      if (entryIsCurrent(previous, candidate)) continue

      const data = await getCompleteSessionPullRequestData(filePath, candidate.size)
      if (expectedGeneration !== generation) return
      entries.set(filePath, { ...data, size: candidate.size, mtimeMs: candidate.mtimeMs })
      if (!samePullRequests(previous, data)) markCatalogChanged("visible")
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

/**
 * The pull requests a listed session is known to have opened, without scanning
 * on the caller's time. A transcript written since its scan keeps its last
 * result until the background index catches up (and then bumps the session
 * catalog); one never scanned, or rewritten shorter, has none yet.
 */
export async function peekSessionPullRequests(candidate: SessionFileCandidate): Promise<SessionPullRequestData | null> {
  await loadIndex()
  const entry = entries.get(candidate.filePath)
  if (!entryIsCurrent(entry, candidate)) {
    queue.set(candidate.filePath, candidate)
    startIndexing()
  }
  if (!entry || entry.size > candidate.size) return null
  return { pullRequests: entry.pullRequests, references: entry.references }
}

setCompletedPullRequestLookup((filePath, size) => {
  const entry = entries.get(filePath)
  return entry?.size === size ? entry.pullRequests : null
})

/** Test helper. */
export function resetSessionPrSearchIndex(): void {
  resetForPath("")
}
