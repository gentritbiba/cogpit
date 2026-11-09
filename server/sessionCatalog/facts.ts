import { mkdir, readFile } from "node:fs/promises"
import { join, sep } from "node:path"
import type { SessionStatusInfo } from "../../shared/session/sessionStatus"
import type { SessionIdentity, SessionMeta } from "../agents/types"
import { writeOwnerOnlyText } from "../atomicJsonFile"
import { dirs } from "../dirs"
import { SESSION_CATALOG_FILE } from "../lib/sessionConfigDir"

/**
 * What the catalog learned about each transcript, kept in memory and saved to
 * `session-catalog.json` so a restart lists from it instead of re-reading
 * every file. Each fact records the size and mtime it was read at; a fact is
 * used again only while that still describes the file.
 */

export interface StampedFact {
  mtimeMs: number
  size: number
}

export interface IdentityFact extends StampedFact {
  identity: SessionIdentity | null
  /** Read whole from the transcript's head, which later writes cannot change. */
  final: boolean
  /** Size and mtime of the side files the identity was also read from, when there are any. */
  sidecars?: string
}

export interface ProjectFact extends StampedFact {
  path: string | null
  final: boolean
}

export interface RowFact extends StampedFact {
  meta: SessionMeta
  status: SessionStatusInfo
}

export interface FileFacts {
  identity?: IdentityFact
  project?: ProjectFact
  row?: RowFact
}

/** Bump when a reader changes what a saved fact would hold, or the file format changes. */
const READER_REVISION = 2
/** Prompt texts are kept this long, in memory and on disk; a search past them reads the transcript. */
const PROMPT_CHARS = 2000
/** Changes are saved at most this often, and once more on shutdown. */
const SAVE_INTERVAL_MS = 60_000
/** Saving and loading yield to the event loop after this much synchronous work. */
const SLICE_MS = 4

const facts = new Map<string, FileFacts>()
let persistence = false
let loading: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
let saving: Promise<void> | null = null

export function factsFor(filePath: string): FileFacts | undefined {
  return facts.get(filePath)
}

function cap(text: string): string {
  return text.length > PROMPT_CHARS ? text.slice(0, PROMPT_CHARS) : text
}

function capped(fact: RowFact): RowFact {
  const { meta } = fact
  if (meta.firstUserMessage.length <= PROMPT_CHARS && meta.lastUserMessage.length <= PROMPT_CHARS) return fact
  return { ...fact, meta: { ...meta, firstUserMessage: cap(meta.firstUserMessage), lastUserMessage: cap(meta.lastUserMessage) } }
}

/** Keep a fact; a row's prompts are capped so the map stays small however many sessions it covers. */
export function recordFact<K extends keyof FileFacts>(filePath: string, kind: K, fact: NonNullable<FileFacts[K]>): NonNullable<FileFacts[K]> {
  const kept = (kind === "row" ? capped(fact as RowFact) : fact) as NonNullable<FileFacts[K]>
  const entry = facts.get(filePath)
  if (entry) entry[kind] = kept
  else facts.set(filePath, { [kind]: kept })
  markDirty()
  return kept
}

export function forgetFacts(filePath: string): void {
  if (facts.delete(filePath)) markDirty()
}

/** Drop facts about files under `root` that a full listing no longer found, such as ones deleted while the server was down. */
export function pruneFactsUnder(root: string, listed: ReadonlySet<string>): void {
  const prefix = root.endsWith(sep) ? root : root + sep
  let pruned = false
  for (const filePath of facts.keys()) {
    if (filePath.startsWith(prefix) && !listed.has(filePath)) {
      facts.delete(filePath)
      pruned = true
    }
  }
  if (pruned) markDirty()
}

/** A fact read at exactly this size and mtime. */
export function isCurrent(fact: StampedFact | undefined, file: StampedFact): boolean {
  return fact !== undefined && fact.mtimeMs === file.mtimeMs && fact.size === file.size
}

/** A final fact holds until the file shrinks or goes back in time, which only a rewrite does. */
export function isStillTrue(fact: (StampedFact & { final: boolean }) | undefined, file: StampedFact): boolean {
  if (!fact) return false
  if (!fact.final) return isCurrent(fact, file)
  return file.size >= fact.size && file.mtimeMs >= fact.mtimeMs
}

function savedPath(): string | null {
  return dirs.SESSION_CONFIG_DIR ? join(dirs.SESSION_CONFIG_DIR, SESSION_CATALOG_FILE) : null
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function markDirty(): void {
  dirty = true
  if (!persistence || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveFacts().catch((error: unknown) => console.warn("[sessionCatalog] could not save the catalog:", error))
  }, SAVE_INTERVAL_MS)
  saveTimer.unref?.()
}

/**
 * Write the catalog when it changed since the last save. One line per file,
 * serialized a slice at a time, so a save never holds the event loop for long.
 */
export async function saveFacts(): Promise<void> {
  if (saving) await saving
  const path = savedPath()
  if (!path || !dirty) return
  dirty = false
  saving = (async () => {
    const lines = [JSON.stringify({ revision: READER_REVISION })]
    let sliceStart = performance.now()
    for (const item of [...facts]) {
      lines.push(JSON.stringify(item))
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToLoop()
        sliceStart = performance.now()
      }
    }
    await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeOwnerOnlyText(path, lines.join("\n"))
  })()
  try {
    await saving
  } catch (error) {
    dirty = true
    throw error
  } finally {
    saving = null
  }
}

/** Save what changed now, for a server shutting down. */
export async function flushFacts(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (persistence) await saveFacts()
}

function isStamped(value: unknown): value is StampedFact {
  return typeof value === "object" && value !== null
    && typeof (value as StampedFact).mtimeMs === "number"
    && typeof (value as StampedFact).size === "number"
}

function validFacts(value: unknown): FileFacts | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as FileFacts
  const entry: FileFacts = {}
  if (isStamped(candidate.identity) && typeof candidate.identity.final === "boolean") entry.identity = candidate.identity
  if (isStamped(candidate.project) && typeof candidate.project.final === "boolean") entry.project = candidate.project
  if (isStamped(candidate.row) && typeof candidate.row.meta === "object" && typeof candidate.row.status === "object") entry.row = capped(candidate.row)
  return entry.identity || entry.project || entry.row ? entry : null
}

async function loadFacts(path: string): Promise<void> {
  let lines: string[]
  try {
    lines = (await readFile(path, "utf-8")).split("\n")
    const header = JSON.parse(lines[0]) as { revision?: unknown }
    if (header?.revision !== READER_REVISION) return
  } catch {
    return
  }
  let sliceStart = performance.now()
  for (let i = 1; i < lines.length; i += 1) {
    try {
      const item = JSON.parse(lines[i]) as unknown
      if (Array.isArray(item) && typeof item[0] === "string" && !facts.has(item[0])) {
        const entry = validFacts(item[1])
        if (entry) facts.set(item[0], entry)
      }
    } catch {
      // A torn or foreign line costs only its own file.
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToLoop()
      sliceStart = performance.now()
    }
  }
}

/**
 * Load the saved catalog once and save changes from now on. Called when the
 * server starts serving; until then nothing is read or written.
 */
export function startFactPersistence(): Promise<void> {
  if (loading) return loading
  persistence = true
  const path = savedPath()
  loading = path ? loadFacts(path) : Promise.resolve()
  return loading
}

/** Resolves once a started load has finished; immediately when none was started. */
export function factsLoaded(): Promise<void> {
  return loading ?? Promise.resolve()
}

/** Test helper. */
export function resetFacts(): void {
  facts.clear()
  persistence = false
  loading = null
  dirty = false
  saving = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}
