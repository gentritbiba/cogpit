import { mkdir, readFile } from "node:fs/promises"
import { join, sep } from "node:path"
import type { SessionStatusInfo } from "../../shared/session/sessionStatus"
import type { SessionIdentity, SessionMeta } from "../agents/types"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
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

/** Bump when a reader changes what a saved fact would hold. */
const READER_REVISION = 1
/** Prompt texts are saved this long; the in-memory copy stays whole. */
const SAVED_PROMPT_CHARS = 2000
const SAVE_DELAY_MS = 5_000

interface SavedCatalog {
  revision: number
  files: Array<[string, FileFacts]>
}

const facts = new Map<string, FileFacts>()
let persistence = false
let loading: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function factsFor(filePath: string): FileFacts | undefined {
  return facts.get(filePath)
}

export function recordFact<K extends keyof FileFacts>(filePath: string, kind: K, fact: NonNullable<FileFacts[K]>): void {
  const entry = facts.get(filePath)
  if (entry) entry[kind] = fact
  else facts.set(filePath, { [kind]: fact })
  scheduleSave()
}

export function forgetFacts(filePath: string): void {
  if (facts.delete(filePath)) scheduleSave()
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
  if (pruned) scheduleSave()
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

function cap(text: string): string {
  return text.length > SAVED_PROMPT_CHARS ? text.slice(0, SAVED_PROMPT_CHARS) : text
}

function savedFacts(entry: FileFacts): FileFacts {
  if (!entry.row) return entry
  const { meta } = entry.row
  return {
    ...entry,
    row: { ...entry.row, meta: { ...meta, firstUserMessage: cap(meta.firstUserMessage), lastUserMessage: cap(meta.lastUserMessage) } },
  }
}

function scheduleSave(): void {
  if (!persistence || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveFacts().catch((error: unknown) => console.warn("[sessionCatalog] could not save the catalog:", error))
  }, SAVE_DELAY_MS)
  saveTimer.unref?.()
}

export async function saveFacts(): Promise<void> {
  const path = savedPath()
  if (!path) return
  const saved: SavedCatalog = {
    revision: READER_REVISION,
    files: [...facts].map(([filePath, entry]) => [filePath, savedFacts(entry)]),
  }
  await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
  await writeOwnerOnlyJson(path, saved)
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
  if (isStamped(candidate.row) && typeof candidate.row.meta === "object" && typeof candidate.row.status === "object") entry.row = candidate.row
  return entry.identity || entry.project || entry.row ? entry : null
}

async function loadFacts(path: string): Promise<void> {
  let saved: Partial<SavedCatalog>
  try {
    saved = JSON.parse(await readFile(path, "utf-8")) as Partial<SavedCatalog>
  } catch {
    return
  }
  if (saved.revision !== READER_REVISION || !Array.isArray(saved.files)) return
  for (const item of saved.files) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || facts.has(item[0])) continue
    const entry = validFacts(item[1])
    if (entry) facts.set(item[0], entry)
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
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}
