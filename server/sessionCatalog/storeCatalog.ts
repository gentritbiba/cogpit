import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import type { AgentDescriptor } from "../../shared/session/agent-descriptors"
import { statContainedFile } from "../agents/containment"
import { readTranscriptHead } from "../agents/transcriptHead"
import type {
  AgentProjectEntry,
  ProjectSessionFileInfo,
  SessionFileInfo,
  SessionIdentity,
  SessionMeta,
  TopLevelSessionInfo,
  TranscriptHead,
} from "../agents/types"
import { markCatalogChanged, reportTouchedFiles } from "./changes"
import { factsFor, factsLoaded, forgetFacts, isStillTrue, pruneFactsUnder, recordFact } from "./facts"

/**
 * One store's session files, kept current by file-system events so a listing
 * walks nothing when nothing changed.
 *
 * Only directories are watched, never files: on Linux Node emulates recursive
 * watching with one watcher per file and directory plus a synchronous walk, so
 * each directory the store lists from gets its own non-recursive watcher.
 * Elsewhere one native recursive watcher covers the root. Events only mark a
 * directory dirty; a short debounce then re-stats the files named, or lists
 * the directory again when an entry came or went. A full rescan every minute
 * is the backstop for anything the events missed.
 *
 * Until `enableSessionCatalogs()` runs (the server starting to serve) and in
 * agent worker processes, every read is a plain walk, as before the catalog.
 */

export interface CatalogDirListing {
  /** Transcripts directly in the directory. */
  files: SessionFileInfo[]
  /** Subdirectories that can hold transcripts. */
  dirs: string[]
}

/** What a store tells its catalog about its layout and its transcripts. */
export interface StoreCatalogSource {
  root(): string | null
  /**
   * One directory of the store's tree, `depth` levels below the root. Throws
   * only where a raw listing would: an unreadable root.
   */
  listDir(root: string, dir: string, depth: number): Promise<CatalogDirListing>
  /** The id a transcript's name carries, if any. */
  sessionIdOf(fileName: string): string | null
  /** The dirName a cwd is addressed by, for a store whose paths do not name the project. */
  encodeDirName(cwd: string): string
  /** The path a dirName encodes, where the encoding can be read back. */
  decodeDirName(dirName: string): string | null
  readIdentity(filePath: string): Promise<SessionIdentity | null>
  readSessionMeta(filePath: string, head: TranscriptHead): Promise<SessionMeta>
  /** Whether an identity read from this file's head can no longer change. */
  identityIsFinal(filePath: string, size: number): boolean
  /** Files beside a transcript its identity may also be read from. */
  identitySidecars?(filePath: string): string[]
  /** The cwd recorded at the head of a transcript whose path names its project. */
  readProjectPath?(filePath: string): Promise<{ path: string | null; final: boolean }>
}

export interface CatalogEntry {
  file: SessionFileInfo
  /** Read from the transcript, for a store whose paths do not name the project. */
  identity: SessionIdentity | null
}

export interface StoreCatalog {
  /** Every transcript, stat-level. */
  files(): Promise<SessionFileInfo[]>
  /** Every transcript with the identity it was placed by. */
  entries(): Promise<CatalogEntry[]>
  topLevelSessions(): Promise<TopLevelSessionInfo[]>
  projects(): Promise<AgentProjectEntry[]>
  /** One project's top-level sessions; empty while the catalog is not running. */
  projectSessionFiles(dirName: string): Promise<ProjectSessionFileInfo[]>
  /** O(1): the transcript whose name carries this id, if the running catalog knows one. */
  sessionFileFor(sessionId: string): string | null
  close(): void
}

const FLUSH_DELAY_MS = 150
const BACKSTOP_MS = 60_000
/** Without a watcher, a listing is reused this long. */
const UNWATCHED_REUSE_MS = 2_000
const RESOLVE_CONCURRENCY = 8
const WATCH_BATCH = 64

let catalogsEnabled = false
const liveCatalogs = new Set<CatalogImpl>()

function isAgentWorker(): boolean {
  return process.env.COGPIT_AGENT_WORKER === "1"
}

/** Start keeping catalogs; from here on listings are served from them. */
export function enableSessionCatalogs(): void {
  if (isAgentWorker()) return
  catalogsEnabled = true
}

/** Test helper: close every catalog and go back to plain walks. */
export function disableSessionCatalogs(): void {
  catalogsEnabled = false
  for (const catalog of liveCatalogs) catalog.close()
}

const useRecursiveWatch = process.platform === "darwin" || process.platform === "win32"

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function eachLimited<T>(values: readonly T[], run: (value: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, values.length) }, async () => {
    while (next < values.length) await run(values[next++])
  }))
}

/** The whole tree, every directory listed once. */
export async function walkStore(
  source: StoreCatalogSource,
  root: string,
): Promise<{ files: SessionFileInfo[]; dirs: Map<string, number> }> {
  const files: SessionFileInfo[] = []
  const dirs = new Map<string, number>([[root, 0]])
  const rootListing = await source.listDir(root, root, 0)
  files.push(...rootListing.files)
  let level = rootListing.dirs.map((dir) => ({ dir, depth: 1 }))
  while (level.length > 0) {
    const nextLevel: Array<{ dir: string; depth: number }> = []
    await eachLimited(level, async ({ dir, depth }) => {
      const listing = await source.listDir(root, dir, depth).catch(() => null)
      if (!listing) return
      dirs.set(dir, depth)
      files.push(...listing.files)
      for (const child of listing.dirs) nextLevel.push({ dir: child, depth: depth + 1 })
    })
    level = nextLevel
  }
  return { files, dirs }
}

interface DirState {
  depth: number
  watcher: FSWatcher | null
}

interface Entry extends CatalogEntry {
  dir: string
  top: TopLevelSessionInfo | null
  /** Size and mtime of the identity's side files when it was placed. */
  sidecars?: string
}

/** Size and mtime of each side file, "-" for one that is missing. */
async function sidecarStamp(paths: readonly string[]): Promise<string> {
  const stamps = await Promise.all(paths.map((path) => stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => "-")))
  return stamps.join(",")
}

class CatalogImpl implements StoreCatalog {
  private root: string | null = null
  private readonly entriesByPath = new Map<string, Entry>()
  private readonly dirStates = new Map<string, DirState>()
  private readonly byId = new Map<string, string>()
  private started: Promise<void> | null = null
  private listedAt = 0
  private watching = false
  private recursiveWatcher: FSWatcher | null = null
  private readonly dirty = new Map<string, Set<string> | "all">()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private backstop: ReturnType<typeof setInterval> | null = null
  private pending: Promise<void> = Promise.resolve()
  private generation = 0
  /** Watchers are being opened; directories found from now on get one too. */
  private watchWanted = false
  /** Known directories whose parent reported them replaced, so their watcher may be dead. */
  private readonly rewatch = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private ancestorWatcher: FSWatcher | null = null
  /** Before the catalog runs, concurrent reads share one walk. */
  private sharedWalk: Promise<CatalogImpl> | null = null
  private sharedFiles: Promise<SessionFileInfo[]> | null = null

  constructor(private readonly source: StoreCatalogSource, private readonly live: boolean) {}

  // ── reads ─────────────────────────────────────────────────────────

  private async current(): Promise<CatalogImpl> {
    if (!this.live || !catalogsEnabled) {
      if (this.started) this.close()
      this.sharedWalk ??= this.snapshot().finally(() => { this.sharedWalk = null })
      return this.sharedWalk
    }
    const root = this.source.root()
    if (root !== this.root) this.reset(root)
    if (!root) return this
    this.started ??= this.start(root)
    try {
      await this.started
    } catch (error) {
      // An unreadable root fails this read as a walk would, and the next read tries again.
      this.close()
      throw error
    }
    if (!this.watching && Date.now() - this.listedAt > UNWATCHED_REUSE_MS) await this.serially(() => this.rescan())
    else if (this.dirty.size > 0) await this.serially(() => this.flush())
    await this.pending
    return this
  }

  /** A plain walk with every identity placed, for reads before the catalog runs. */
  private async snapshot(): Promise<CatalogImpl> {
    const snapshot = new CatalogImpl(this.source, false)
    const root = this.source.root()
    snapshot.root = root
    if (root) await snapshot.applyWalk(root)
    return snapshot
  }

  async files(): Promise<SessionFileInfo[]> {
    if (!this.live || !catalogsEnabled) {
      // Stat-level: nothing here needs an identity.
      const root = this.source.root()
      if (!root) return []
      this.sharedFiles ??= walkStore(this.source, root).then(({ files }) => files).finally(() => { this.sharedFiles = null })
      return this.sharedFiles
    }
    return [...(await this.current()).entriesByPath.values()].map((entry) => entry.file)
  }

  async entries(): Promise<CatalogEntry[]> {
    return [...(await this.current()).entriesByPath.values()].map(({ file, identity }) => ({ file, identity }))
  }

  async topLevelSessions(): Promise<TopLevelSessionInfo[]> {
    const catalog = await this.current()
    const sessions: TopLevelSessionInfo[] = []
    for (const entry of catalog.entriesByPath.values()) if (entry.top) sessions.push(entry.top)
    return sessions
  }

  async projects(): Promise<AgentProjectEntry[]> {
    const catalog = await this.current()
    const byDirName = new Map<string, TopLevelSessionInfo[]>()
    for (const entry of catalog.entriesByPath.values()) {
      if (!entry.top) continue
      const bucket = byDirName.get(entry.top.dirName)
      if (bucket) bucket.push(entry.top)
      else byDirName.set(entry.top.dirName, [entry.top])
    }
    const projects: AgentProjectEntry[] = []
    await eachLimited([...byDirName], async ([dirName, sessions]) => {
      const newest = sessions.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b))
      projects.push({
        dirName,
        path: newest.projectPath ?? await catalog.projectPath(newest) ?? this.source.decodeDirName(dirName) ?? dirName,
        sessionCount: sessions.length,
        lastModified: newest.mtimeMs ? new Date(newest.mtimeMs).toISOString() : null,
      })
    })
    return projects
  }

  async projectSessionFiles(dirName: string): Promise<ProjectSessionFileInfo[]> {
    // A plain walk of every project to answer for one would cost more than the store's own read.
    if (!this.live || !catalogsEnabled) return []
    const catalog = await this.current()
    const files: ProjectSessionFileInfo[] = []
    for (const entry of catalog.entriesByPath.values()) {
      if (entry.top?.dirName !== dirName) continue
      const { filePath, fileName, mtimeMs, size } = entry.top
      files.push({ filePath, fileName, dirName, mtimeMs, size, ...(entry.identity && { sessionId: entry.top.sessionId }) })
    }
    return files
  }

  sessionFileFor(sessionId: string): string | null {
    if (!this.started || !catalogsEnabled) return null
    return this.byId.get(sessionId) ?? null
  }

  /** The project cwd of a path-addressed session, read from its head once per file. */
  private async projectPath(session: TopLevelSessionInfo): Promise<string | null> {
    if (!this.source.readProjectPath) return null
    const known = this.live ? factsFor(session.filePath)?.project : undefined
    if (isStillTrue(known, session)) return known!.path
    try {
      const { path, final } = await this.source.readProjectPath(session.filePath)
      if (this.live) recordFact(session.filePath, "project", { path, final, mtimeMs: session.mtimeMs, size: session.size })
      return path
    } catch {
      return null
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  private reset(root: string | null): void {
    this.close()
    this.root = root
  }

  close(): void {
    this.generation += 1
    for (const state of this.dirStates.values()) state.watcher?.close()
    this.recursiveWatcher?.close()
    this.recursiveWatcher = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.backstop) clearInterval(this.backstop)
    this.flushTimer = null
    this.backstop = null
    this.dirty.clear()
    this.dirStates.clear()
    this.entriesByPath.clear()
    this.byId.clear()
    this.started = null
    this.watching = false
    this.watchWanted = false
    this.rewatch.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ancestorWatcher?.close()
    this.ancestorWatcher = null
    this.listedAt = 0
    liveCatalogs.delete(this)
  }

  private async start(root: string): Promise<void> {
    const generation = this.generation
    liveCatalogs.add(this)
    await factsLoaded()
    await this.applyWalk(root)
    if (generation !== this.generation) return
    setImmediate(() => { void this.watchAll(generation) })
  }

  /** Runs catalog mutations one at a time. */
  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.pending.then(task, task)
    this.pending = run.catch((error: unknown) => console.error("[sessionCatalog] update failed:", error))
    return this.pending
  }

  // ── watching ──────────────────────────────────────────────────────

  private async watchAll(generation: number): Promise<void> {
    const root = this.root
    if (!root || generation !== this.generation) return
    this.watchWanted = true
    try {
      if (useRecursiveWatch) {
        this.recursiveWatcher = this.openWatcher(root, true)
      } else {
        const dirs = [...this.dirStates.keys()]
        this.watchDir(root)
        for (let i = 0; i < dirs.length; i += WATCH_BATCH) {
          if (generation !== this.generation) return
          for (const dir of dirs.slice(i, i + WATCH_BATCH)) this.watchFound(dir)
          await yieldToLoop()
        }
        // Directories found while the batches ran.
        if (generation !== this.generation) return
        for (const dir of this.dirStates.keys()) this.watchFound(dir)
      }
    } catch (error) {
      this.unwatchAll()
      this.retryWatching(generation, (error as NodeJS.ErrnoException).code === "ENOENT")
      return
    }
    // A watcher that failed while the batches ran gave up watching and scheduled its own retry.
    if (generation !== this.generation || !this.watchWanted) return
    this.watching = true
    this.backstop = setInterval(() => { void this.serially(() => this.rescan()) }, BACKSTOP_MS)
    this.backstop.unref?.()
    // Writes made while the watchers were being opened went unseen.
    void this.serially(() => this.rescan())
  }

  /**
   * Watching failed. Try again on the backstop and, while the root does not
   * exist yet (an agent installed later), at once when the nearest existing
   * parent of the root reports a change.
   */
  private retryWatching(generation: number, viaAncestor: boolean): void {
    if (generation !== this.generation || this.retryTimer) return
    const retry = () => {
      if (generation !== this.generation) return
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.ancestorWatcher?.close()
      this.ancestorWatcher = null
      void this.serially(() => this.rescan()).then(() => this.watchAll(generation))
    }
    this.retryTimer = setTimeout(retry, BACKSTOP_MS)
    this.retryTimer.unref?.()
    if (viaAncestor) void this.watchNearestAncestor(generation, retry)
  }

  private async watchNearestAncestor(generation: number, retry: () => void): Promise<void> {
    let dir = this.root
    while (dir) {
      const parent = dirname(dir)
      if (parent === dir) return
      dir = parent
      if (!(await stat(dir).then((info) => info.isDirectory(), () => false))) continue
      if (generation !== this.generation || !this.retryTimer) return
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          if (this.ancestorWatcher === watcher) retry()
        })
        watcher.on("error", () => watcher.close())
        this.ancestorWatcher = watcher
      } catch {
        // The backstop retry still runs.
      }
      return
    }
  }

  private openWatcher(dir: string, recursive: boolean): FSWatcher {
    const watcher = watch(dir, { persistent: false, recursive }, (event, name) => {
      if (recursive) this.onRecursiveEvent(event, name ? String(name) : null)
      else this.onEvent(dir, event, name ? String(name) : null)
    })
    watcher.on("error", () => this.onWatcherError())
    return watcher
  }

  private watchDir(dir: string): void {
    const state = this.dirStates.get(dir)
    if (!state || state.watcher || useRecursiveWatch) return
    state.watcher = this.openWatcher(dir, false)
  }

  /** Watch a directory below the root once watching began. One already gone is left to its parent's relist. */
  private watchFound(dir: string): void {
    if (!this.watchWanted) return
    try {
      this.watchDir(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") this.onWatcherError()
    }
  }

  private unwatchAll(): void {
    for (const state of this.dirStates.values()) {
      state.watcher?.close()
      state.watcher = null
    }
    this.recursiveWatcher?.close()
    this.recursiveWatcher = null
    this.watching = false
    this.watchWanted = false
    if (this.backstop) clearInterval(this.backstop)
    this.backstop = null
  }

  /**
   * A failed watcher may have missed events: rescan once, read from the 2 s
   * listing meanwhile, and try watching again on the backstop. Retrying at once
   * spins when the failure persists (ENOSPC: the inotify watch limit is used up).
   */
  private onWatcherError(): void {
    this.unwatchAll()
    const generation = this.generation
    void this.serially(() => this.rescan())
    this.retryWatching(generation, false)
  }

  private onRecursiveEvent(event: string, name: string | null): void {
    if (!this.root) return
    if (!name) {
      this.markDirty(this.root, null, event)
      return
    }
    const path = join(this.root, name)
    const dir = dirname(path)
    if (this.dirStates.has(dir)) this.markDirty(dir, path.slice(dir.length + 1), event)
  }

  private onEvent(dir: string, event: string, name: string | null): void {
    this.markDirty(dir, name, event)
  }

  private markDirty(dir: string, name: string | null, event: string): void {
    if (event === "rename" && name && this.dirStates.has(join(dir, name))) this.rewatch.add(join(dir, name))
    const known = this.dirty.get(dir)
    if (known !== "all") {
      if (event === "change" && name && this.entriesByPath.has(join(dir, name))) {
        if (known) known.add(name)
        else this.dirty.set(dir, new Set([name]))
      } else {
        this.dirty.set(dir, "all")
      }
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.serially(() => this.flush())
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  // ── updates ───────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    const root = this.root
    if (!root || this.dirty.size === 0) return
    const generation = this.generation
    const work = [...this.dirty]
    this.dirty.clear()
    const changes = new Changes()
    for (const [dir, names] of work) {
      const state = this.dirStates.get(dir)
      if (!state) continue
      if (names === "all") {
        await this.relistDir(root, dir, state.depth, changes, generation)
        continue
      }
      for (const name of names) {
        const filePath = join(dir, name)
        const entry = this.entriesByPath.get(filePath)
        if (!entry) continue
        const stats = await statContainedFile(root, filePath)
        if (generation !== this.generation) return
        if (!stats) {
          await this.relistDir(root, dir, state.depth, changes, generation)
          break
        }
        if (stats.mtimeMs !== entry.file.mtimeMs || stats.size !== entry.file.size) {
          await this.place({ ...entry.file, ...stats }, dir, changes, generation)
        }
      }
    }
    if (generation === this.generation) changes.publish()
  }

  /** List one directory again; a new subdirectory is walked and watched, a gone one dropped. */
  private async relistDir(root: string, dir: string, depth: number, changes: Changes, generation: number): Promise<void> {
    let listing: CatalogDirListing
    try {
      listing = await this.source.listDir(root, dir, depth)
    } catch {
      if (generation === this.generation && dir !== root) this.dropDir(dir, changes)
      return
    }
    if (generation !== this.generation) return
    const listed = new Set(listing.files.map((file) => file.filePath))
    for (const [filePath, entry] of this.entriesByPath) {
      if (entry.dir === dir && !listed.has(filePath)) this.remove(filePath, changes)
    }
    await eachLimited(listing.files, (file) => this.placeIfChanged(file, dir, changes, generation))
    if (generation !== this.generation) return
    const children = new Set(listing.dirs)
    for (const known of [...this.dirStates.keys()]) {
      if (known !== dir && dirname(known) === dir && !children.has(known)) this.dropDir(known, changes)
    }
    for (const child of listing.dirs) {
      const known = this.dirStates.get(child)
      // A directory replaced under the same name has a watcher on the old one.
      const replaced = this.rewatch.delete(child)
      if (known && !replaced) continue
      known?.watcher?.close()
      this.dirStates.set(child, { depth: depth + 1, watcher: null })
      this.watchFound(child)
      await this.relistDir(root, child, depth + 1, changes, generation)
      if (generation !== this.generation) return
    }
  }

  private dropDir(dir: string, changes: Changes): void {
    for (const [known, state] of [...this.dirStates]) {
      if (known !== dir && !known.startsWith(dir + sep)) continue
      state.watcher?.close()
      this.dirStates.delete(known)
    }
    for (const [filePath, entry] of [...this.entriesByPath]) {
      if (entry.dir === dir || entry.dir.startsWith(dir + sep)) this.remove(filePath, changes)
    }
  }

  /** Walk everything and apply the difference. */
  private async rescan(): Promise<void> {
    const root = this.root
    if (!root) return
    const generation = this.generation
    const changes = new Changes()
    await this.applyWalk(root, changes)
    if (generation === this.generation) changes.publish()
  }

  /** Walk everything and apply it, unless the root changed or the catalog closed meanwhile. */
  private async applyWalk(root: string, changes = new Changes()): Promise<void> {
    const generation = this.generation
    const { files, dirs } = await walkStore(this.source, root)
    if (generation !== this.generation || root !== this.root) return
    this.listedAt = Date.now()
    for (const [dir, state] of [...this.dirStates]) {
      if (dirs.has(dir)) continue
      state.watcher?.close()
      this.dirStates.delete(dir)
    }
    for (const [dir, depth] of dirs) {
      if (this.dirStates.has(dir)) continue
      this.dirStates.set(dir, { depth, watcher: null })
      this.watchFound(dir)
    }
    const listed = new Set(files.map((file) => file.filePath))
    for (const filePath of [...this.entriesByPath.keys()]) {
      if (!listed.has(filePath)) this.remove(filePath, changes)
    }
    if (this.live) pruneFactsUnder(root, listed)
    await eachLimited(files, (file) => this.placeIfChanged(file, dirname(file.filePath), changes, generation))
  }

  private remove(filePath: string, changes: Changes): void {
    const entry = this.entriesByPath.get(filePath)
    if (!entry) return
    this.entriesByPath.delete(filePath)
    const id = this.source.sessionIdOf(entry.file.fileName)
    if (id && this.byId.get(id) === filePath) this.byId.delete(id)
    if (this.live) forgetFacts(filePath)
    if (entry.top) changes.visible = true
  }

  /** Place a listed file unless it, and the side files its identity came from, are unchanged. */
  private async placeIfChanged(file: SessionFileInfo, dir: string, changes: Changes, generation: number): Promise<void> {
    const entry = this.entriesByPath.get(file.filePath)
    if (entry && entry.file.mtimeMs === file.mtimeMs && entry.file.size === file.size) {
      const sidecars = file.dirName === null ? this.source.identitySidecars?.(file.filePath) : undefined
      if (!sidecars || await sidecarStamp(sidecars) === entry.sidecars) return
    }
    if (generation === this.generation) await this.place(file, dir, changes, generation)
  }

  /** Add or update one listed file, reading its identity when its path does not place it. */
  private async place(file: SessionFileInfo, dir: string, changes: Changes, generation: number): Promise<void> {
    const previous = this.entriesByPath.get(file.filePath)
    const placed = file.dirName === null ? await this.identityOf(file) : null
    if (generation !== this.generation) return
    const identity = placed?.identity ?? null
    const entry: Entry = { file, dir, identity, top: this.topLevel(file, identity), sidecars: placed?.sidecars }
    this.entriesByPath.set(file.filePath, entry)
    const id = this.source.sessionIdOf(file.fileName)
    if (id) {
      const holder = this.byId.get(id)
      const holderEntry = holder ? this.entriesByPath.get(holder) : undefined
      if (!holderEntry || holder === file.filePath || holderEntry.file.mtimeMs <= file.mtimeMs) this.byId.set(id, file.filePath)
    }
    if (!previous) {
      if (entry.top) changes.visible = true
      return
    }
    if (!sameTop(previous.top, entry.top)) changes.visible = true
    else if (entry.top) changes.touched.push(entry.top)
    else changes.touchedOther = true
  }

  private topLevel(file: SessionFileInfo, identity: SessionIdentity | null): TopLevelSessionInfo | null {
    if (file.dirName !== null) return { ...file, dirName: file.dirName }
    if (!identity || identity.isSubagent) return null
    return {
      filePath: file.filePath,
      fileName: file.fileName,
      dirName: this.source.encodeDirName(identity.cwd),
      mtimeMs: file.mtimeMs,
      size: file.size,
      projectPath: identity.cwd,
      sessionId: identity.sessionId,
    }
  }

  private async identityOf(file: SessionFileInfo): Promise<{ identity: SessionIdentity | null; sidecars?: string }> {
    const sidecarPaths = this.source.identitySidecars?.(file.filePath)
    const sidecars = sidecarPaths ? await sidecarStamp(sidecarPaths) : undefined
    const known = this.live ? factsFor(file.filePath)?.identity : undefined
    if (isStillTrue(known, file) && known!.sidecars === sidecars) return { identity: known!.identity, sidecars }
    let identity = await this.source.readIdentity(file.filePath).catch(() => null)
    let final = identity !== null && this.source.identityIsFinal(file.filePath, file.size)
    // Unusual or legacy transcripts whose head lacks the identity pay for the full metadata parse.
    if (!identity) {
      final = false
      try {
        const meta = await this.source.readSessionMeta(file.filePath, await readTranscriptHead(file.filePath))
        identity = meta.cwd
          ? { sessionId: meta.sessionId, cwd: meta.cwd, gitBranch: meta.gitBranch, isSubagent: meta.isSubagent, parentSessionId: meta.parentSessionId }
          : null
      } catch {
        identity = null
      }
    }
    // The path wins over the header where the layout encodes the id: a forked
    // or resumed session can carry a header id from the session it came from.
    if (identity) identity = { ...identity, sessionId: this.source.sessionIdOf(file.fileName) ?? identity.sessionId }
    if (this.live) {
      recordFact(file.filePath, "identity", { identity, final, mtimeMs: file.mtimeMs, size: file.size, ...(sidecars !== undefined && { sidecars }) })
    }
    return { identity, sidecars }
  }
}

function sameTop(a: TopLevelSessionInfo | null, b: TopLevelSessionInfo | null): boolean {
  if (!a || !b) return a === b
  return a.dirName === b.dirName && a.sessionId === b.sessionId && a.projectPath === b.projectPath
}

/** What one update changed, published as a single version bump. */
class Changes {
  visible = false
  touched: TopLevelSessionInfo[] = []
  touchedOther = false

  publish(): void {
    if (this.visible) {
      markCatalogChanged("visible")
      return
    }
    if (this.touched.length > 0) reportTouchedFiles(this.touched)
    if (this.touched.length > 0 || this.touchedOther) markCatalogChanged("touch")
  }
}

export function createStoreCatalog(source: StoreCatalogSource): StoreCatalog {
  return new CatalogImpl(source, !isAgentWorker())
}

/** The parts of a catalog source every store reads off its descriptor. */
export function descriptorAddressing(descriptor: AgentDescriptor): Pick<StoreCatalogSource, "sessionIdOf" | "encodeDirName" | "decodeDirName"> {
  return {
    sessionIdOf: (fileName) => descriptor.sessionFile.sessionId(fileName),
    encodeDirName: (cwd) => descriptor.dirName.encode(cwd),
    decodeDirName: (dirName) => descriptor.dirName.decode(dirName),
  }
}

/** The store listings a catalog answers directly. */
export function catalogListings(catalog: StoreCatalog) {
  return {
    listProjects: () => catalog.projects(),
    listTopLevelSessions: () => catalog.topLevelSessions(),
    listedSessionFiles: () => catalog.files(),
    knownSessionFile: (sessionId: string) => catalog.sessionFileFor(sessionId),
    dispose: () => catalog.close(),
  }
}

/** The `fileName` a transcript at `filePath` is addressed by, relative to the root and forward-slashed. */
export function rootRelativeName(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/")
}
