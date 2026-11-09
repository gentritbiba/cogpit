/**
 * The session catalog's revision counter. Every change bumps it once; the
 * kind says whether a list row could look different (`visible`: a session
 * appeared or left, or a row's metadata or status changed) or only a file's
 * size and mtime moved (`touch`).
 */

export type CatalogChangeKind = "visible" | "touch"

export interface CatalogChange {
  version: number
  kind: CatalogChangeKind
}

type Listener = (change: CatalogChange) => void

let version = 0
const listeners = new Set<Listener>()

export function catalogVersion(): number {
  return version
}

/** Bump the version. Row inputs that change without a file event report here too. */
export function markCatalogChanged(kind: CatalogChangeKind): void {
  version += 1
  const change = { version, kind }
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (error) {
      console.error("[sessionCatalog] change listener failed:", error)
    }
  }
}

export function subscribeCatalog(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether anyone is listening, so work that only feeds listeners can stop. */
export function hasCatalogListeners(): boolean {
  return listeners.size > 0
}

/** A file whose size or mtime moved, as the catalog now lists it. */
export interface TouchedFile {
  filePath: string
  mtimeMs: number
  size: number
}

type TouchListener = (files: readonly TouchedFile[]) => void
const touchListeners = new Set<TouchListener>()

/** Tell row readers which listed sessions were written, before the touch is published. */
export function reportTouchedFiles(files: readonly TouchedFile[]): void {
  for (const listener of touchListeners) listener(files)
}

export function subscribeTouchedFiles(listener: TouchListener): () => void {
  touchListeners.add(listener)
  return () => {
    touchListeners.delete(listener)
  }
}
