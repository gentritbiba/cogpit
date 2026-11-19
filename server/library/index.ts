/**
 * The library on this computer: `library/` beside the memory store it is fed
 * from (`~/.cogpit/library`; `COGPIT_LIBRARY_HOME` overrides it) holds
 * `library.db` and the kept copies under `files/`. It is brought up to date
 * after each pass of the memory indexer, one run at a time.
 */
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SqlDatabase } from "../../shared/memory/database"
import type { MemoryStore } from "../../shared/memory/store"
import { memoryDir } from "../memory/paths"
import { openDatabase } from "../orchestration/database"
import { keepPending } from "./keep"
import { LibraryStore } from "./store"
import { syncLibrary } from "./sync"

export const LIBRARY_HOME_ENV = "COGPIT_LIBRARY_HOME"

/** A server indexing its own memory store keeps its own library too. */
export function libraryHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[LIBRARY_HOME_ENV]?.trim() || join(dirname(memoryDir(env)), "library")
}

export function libraryFilesDir(home = libraryHome()): string {
  return join(home, "files")
}

interface OpenLibrary {
  home: string
  store: LibraryStore
}

let opened: OpenLibrary | null = null
let unavailableAt: string | null = null
let syncing: Promise<unknown> | null = null
let keeping: Promise<void> | null = null
let keepAgain = false
let controller = new AbortController()

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The store for the current home, opened on first use; null when it cannot work here. */
export function libraryStore(): LibraryStore | null {
  const home = libraryHome()
  if (opened?.home === home) return opened.store
  if (unavailableAt === home) return null
  opened?.store.close()
  opened = null
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, "library.db")
    // SQLite gives the WAL and shared-memory files the database file's mode.
    closeSync(openSync(path, "a", 0o600))
    opened = { home, store: LibraryStore.open(openDatabase(path) as SqlDatabase) }
    return opened.store
  } catch (error) {
    unavailableAt = home
    console.warn(`[library] off: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Reads what the memory store synced since the last run. The memory indexer
 * awaits this, so its store stays open meanwhile; copies of new local files
 * are made after, without holding up the indexer.
 */
export async function syncLibraryFrom(memory: MemoryStore): Promise<void> {
  const store = libraryStore()
  if (!store) return
  const { signal } = controller
  const run = syncing = syncLibrary(memory, store, { pause: yieldToEventLoop, signal })
  try {
    await run
  } finally {
    if (syncing === run) syncing = null
  }
  if (!signal.aborted) keepCopies(store)
}

function keepCopies(store: LibraryStore): void {
  if (keeping) {
    keepAgain = true
    return
  }
  const { signal } = controller
  keeping = (async () => {
    do {
      keepAgain = false
      await keepPending(store, libraryFilesDir(), { pause: yieldToEventLoop, signal })
    } while (keepAgain && !signal.aborted)
  })()
    .catch((error: unknown) => console.warn(`[library] keeping copies failed: ${String(error)}`))
    .finally(() => { keeping = null })
}

/** Stops reading and copying at the next file, then closes the store. Call it before awaiting the memory indexer's stop, which waits for the read. */
export async function stopLibrary(): Promise<void> {
  controller.abort()
  controller = new AbortController()
  await syncing?.catch(() => {})
  await keeping
  opened?.store.close()
  opened = null
  unavailableAt = null
}
