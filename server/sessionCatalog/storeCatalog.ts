import { watch, type FSWatcher } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
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
import { factsFor, factsLoaded, forgetFacts, isStillTrue, recordFact } from "./facts"

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

  constructor(private readonly source: StoreCatalogSource, private readonly live: boolean) {}

  // ── reads ─────────────────────────────────────────────────────────

  private async current(): Promise<CatalogImpl> {
    if (!this.live || !catalogsEnabled) {
      if (this.started) this.close()
      const snapshot = new CatalogImpl(this.source, false)
      const root = this.source.root()
      if (root) await snapshot.applyWalk(root)
      return snapshot
    }
    const root = this.source.root()
    if (root !== this.root) this.reset(root)
    if (!root) return this
    this.started ??= this.start(root)
    await this.started
    if (!this.watching && Date.now() - this.listedAt > UNWATCHED_REUSE_MS) await this.serially(() => this.rescan())
    else if (this.dirty.size > 0) await this.serially(() => this.flush())
    await this.pending
    return this
  }

  async files(): Promise<SessionFileInfo[]> {
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
    const known = factsFor(session.filePath)?.project
    if (isStillTrue(known, session)) return known!.path
    try {
      const { path, final } = await this.source.readProjectPath(session.filePath)
      recordFact(session.filePath, "project", { path, final, mtimeMs: session.mtimeMs, size: session.size })
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
    this.listedAt = 0
    liveCatalogs.delete(this)
  }

  private async start(root: string): Promise<void> {
    liveCatalogs.add(this)
    await factsLoaded()
    await this.applyWalk(root)
    const generation = this.generation
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
    try {
      if (useRecursiveWatch) {
        this.recursiveWatcher = this.openWatcher(root, true)
      } else {
        const dirs = [...this.dirStates.keys()]
        for (let i = 0; i < dirs.length; i += WATCH_BATCH) {
          if (generation !== this.generation) return
          for (const dir of dirs.slice(i, i + WATCH_BATCH)) this.watchDir(dir)
          await yieldToLoop()
        }
      }
    } catch {
      this.unwatchAll()
      return
    }
    if (generation !== this.generation) return
    this.watching = true
    this.backstop = setInterval(() => { void this.serially(() => this.rescan()) }, BACKSTOP_MS)
    this.backstop.unref?.()
    // Writes made while the watchers were being opened went unseen.
    void this.serially(() => this.rescan())
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

  private unwatchAll(): void {
    for (const state of this.dirStates.values()) {
      state.watcher?.close()
      state.watcher = null
    }
    this.recursiveWatcher?.close()
    this.recursiveWatcher = null
    this.watching = false
    if (this.backstop) clearInterval(this.backstop)
    this.backstop = null
  }

  /** A failed watcher may have missed events: rescan, and stay on the 2 s listing if watching keeps failing. */
  private onWatcherError(): void {
    this.unwatchAll()
    const generation = this.generation
    void this.serially(() => this.rescan()).then(() => this.watchAll(generation))
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
    const work = [...this.dirty]
    this.dirty.clear()
    const changes = new Changes()
    for (const [dir, names] of work) {
      const state = this.dirStates.get(dir)
      if (!state) continue
      if (names === "all") {
        await this.relistDir(root, dir, state.depth, changes)
        continue
      }
      for (const name of names) {
        const filePath = join(dir, name)
        const entry = this.entriesByPath.get(filePath)
        if (!entry) continue
        const stats = await statContainedFile(root, filePath)
        if (!stats) {
          await this.relistDir(root, dir, state.depth, changes)
          break
        }
        if (stats.mtimeMs !== entry.file.mtimeMs || stats.size !== entry.file.size) {
          await this.place({ ...entry.file, ...stats }, dir, changes)
        }
      }
    }
    changes.publish()
  }

  /** List one directory again; a new subdirectory is walked and watched, a gone one dropped. */
  private async relistDir(root: string, dir: string, depth: number, changes: Changes): Promise<void> {
    let listing: CatalogDirListing
    try {
      listing = await this.source.listDir(root, dir, depth)
    } catch {
      if (dir !== root) this.dropDir(dir, changes)
      return
    }
    const listed = new Set(listing.files.map((file) => file.filePath))
    for (const [filePath, entry] of this.entriesByPath) {
      if (entry.dir === dir && !listed.has(filePath)) this.remove(filePath, changes)
    }
    await eachLimited(listing.files, (file) => this.place(file, dir, changes))
    const children = new Set(listing.dirs)
    for (const known of [...this.dirStates.keys()]) {
      if (known !== dir && dirname(known) === dir && !children.has(known)) this.dropDir(known, changes)
    }
    for (const child of listing.dirs) {
      if (this.dirStates.has(child)) continue
      this.dirStates.set(child, { depth: depth + 1, watcher: null })
      if (this.watching) this.watchDir(child)
      await this.relistDir(root, child, depth + 1, changes)
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
    const changes = new Changes()
    await this.applyWalk(root, changes)
    changes.publish()
  }

  private async applyWalk(root: string, changes = new Changes()): Promise<void> {
    this.root = root
    const { files, dirs } = await walkStore(this.source, root)
    this.listedAt = Date.now()
    for (const [dir, state] of [...this.dirStates]) {
      if (dirs.has(dir)) continue
      state.watcher?.close()
      this.dirStates.delete(dir)
    }
    for (const [dir, depth] of dirs) {
      if (this.dirStates.has(dir)) continue
      this.dirStates.set(dir, { depth, watcher: null })
      if (this.watching) this.watchDir(dir)
    }
    const listed = new Set(files.map((file) => file.filePath))
    for (const filePath of [...this.entriesByPath.keys()]) {
      if (!listed.has(filePath)) this.remove(filePath, changes)
    }
    await eachLimited(files, async (file) => {
      const entry = this.entriesByPath.get(file.filePath)
      if (entry && entry.file.mtimeMs === file.mtimeMs && entry.file.size === file.size) return
      await this.place(file, dirname(file.filePath), changes)
    })
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

  /** Add or update one listed file, reading its identity when its path does not place it. */
  private async place(file: SessionFileInfo, dir: string, changes: Changes): Promise<void> {
    const previous = this.entriesByPath.get(file.filePath)
    const identity = file.dirName === null ? await this.identityOf(file) : null
    const entry: Entry = { file, dir, identity, top: this.topLevel(file, identity) }
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

  private async identityOf(file: SessionFileInfo): Promise<SessionIdentity | null> {
    const known = this.live ? factsFor(file.filePath)?.identity : undefined
    if (isStillTrue(known, file)) return known!.identity
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
    if (this.live) recordFact(file.filePath, "identity", { identity, final, mtimeMs: file.mtimeMs, size: file.size })
    return identity
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

/** The `fileName` a transcript at `filePath` is addressed by, relative to the root and forward-slashed. */
export function rootRelativeName(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/")
}
