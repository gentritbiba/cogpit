/**
 * Stored views on this computer, one folder each:
 *
 *   <root>/<id>/view.json         title, project, versions
 *   <root>/<id>/app/              the source the agent edits
 *   <root>/<id>/versions/<n>/     immutable: index.html and files.json
 *
 * Deleting a view removes its source and versions but keeps view.json marked
 * `deleted`, so the id stays tied to the session that made it, deleting again
 * answers the same, and no new view can take the id: a reply's `<id>@<n>`
 * never shows another view's page.
 *
 * Ids are unique on the computer; the project a view belongs to is recorded
 * in view.json, so a reply's `<id>@<n>` needs nothing else to find it.
 */
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isViewId, type ViewSourceFile, type ViewSummary, type ViewUpdate } from "../../shared/views/stored"
import { parseWorktreePath } from "../../shared/worktreePath"

export interface ViewVersionMeta {
  version: number
  createdAt: string
  sessionId?: string
  hash: string
}

export interface ViewRecord {
  id: string
  title: string
  /** The project folder the view was made in, with worktrees folded into their parent. */
  project: string
  sessionId?: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  deleted?: true
  versions: ViewVersionMeta[]
}

export function viewSummary(record: ViewRecord): ViewSummary {
  return {
    id: record.id,
    title: record.title,
    project: record.project,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    latestVersion: record.versions.at(-1)?.version ?? null,
    updatedAt: record.updatedAt,
    pinned: record.pinned === true,
  }
}

const MAX_TITLE = 200

/** The project a folder belongs to for views: a worktree counts as its parent checkout. */
export function projectOfCwd(cwd: string): string {
  return parseWorktreePath(cwd)?.parentPath ?? cwd
}

export class ViewStoreError extends Error {}

export function invalidViewIdMessage(id: string): string {
  return `"${id}" is not a view id: use lowercase letters, digits and single hyphens, up to 48 characters`
}

export const VIEW_LIMITS = Object.freeze({ files: 40, depth: 4, sourceBytes: 512 * 1024, dataBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 })

const SOURCE_EXTENSIONS = /\.(?:tsx|ts|jsx|js|css)$/
const DATA_EXTENSION = /\.json$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const RESERVED_IDS = new Set(["shell"])

export const STARTER_APP = `import { useState } from "react"
import { Card, Slider, Stack, Stat } from "cogpit/ui"

export default function App() {
  const [value, setValue] = useState(50)
  return (
    <Card title="Starter">
      <Stack>
        <Slider label="Value" min={0} max={100} value={value} onChange={setValue} />
        <Stat label="Doubled" value={value * 2} />
      </Stack>
    </Card>
  )
}
`

export function defaultViewsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COGPIT_VIEWS_HOME || join(homedir(), ".cogpit", "views")
}

/** Replaces `<dir>/view.json` in one step, so a reader never sees half a record. */
async function writeRecord(dir: string, record: ViewRecord): Promise<void> {
  const path = join(dir, "view.json")
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`)
  await rename(temporary, path)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

export type ViewStore = ReturnType<typeof createViewStore>

export function createViewStore(root: string = defaultViewsRoot()) {
  const folder = (id: string) => {
    if (!isViewId(id)) throw new ViewStoreError(invalidViewIdMessage(id))
    return join(root, id)
  }
  const appDir = (id: string) => join(folder(id), "app")

  /** Builds of one view run one at a time, so two never take the same version number. */
  const queues = new Map<string, Promise<unknown>>()
  function exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).then(task)
    const settled = run.catch(() => {})
    queues.set(id, settled)
    void settled.then(() => { if (queues.get(id) === settled) queues.delete(id) })
    return run
  }

  /** The view, or null when there is none; `includeDeleted` also returns a deleted view's tombstone. */
  async function read(id: string, { includeDeleted = false } = {}): Promise<ViewRecord | null> {
    let record: ViewRecord
    try {
      record = JSON.parse(await readFile(join(folder(id), "view.json"), "utf8")) as ViewRecord
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
    return record.deleted && !includeDeleted ? null : record
  }

  async function create({ id, title, project, sessionId }: { id: string; title: string; project: string; sessionId?: string }): Promise<ViewRecord> {
    if (RESERVED_IDS.has(id)) throw new ViewStoreError(`"${id}" is reserved; pick another id`)
    const dir = folder(id)
    return exclusive(id, async () => {
      const existing = await read(id, { includeDeleted: true })
      if (existing?.deleted) throw new ViewStoreError(`View "${id}" was deleted and its id stays retired; pick another id`)
      if (existing) {
        throw new ViewStoreError(`View "${id}" already exists (project ${existing.project}). Edit its files in ${appDir(id)} and build it again, or pick another id`)
      }
      await mkdir(join(dir, "app"), { recursive: true })
      await mkdir(join(dir, "versions"), { recursive: true })
      await writeFile(join(dir, "app", "App.tsx"), STARTER_APP)
      const now = new Date().toISOString()
      const record: ViewRecord = { id, title, project, ...(sessionId ? { sessionId } : {}), createdAt: now, updatedAt: now, versions: [] }
      await writeRecord(dir, record)
      return record
    })
  }

  async function list(): Promise<ViewRecord[]> {
    let names: string[]
    try {
      names = await readdir(root)
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const records = await Promise.all(names.filter(isViewId).map((name) => read(name).catch(() => null)))
    return records.filter((record): record is ViewRecord => record !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** The view's source, refusing links, odd names and anything over the limits. */
  async function readSources(id: string): Promise<ViewSourceFile[]> {
    const files: ViewSourceFile[] = []
    let total = 0
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      const entries = await readdir(dir).catch((error: unknown) => {
        if (missing(error)) throw new ViewStoreError(`View "${id}" has no app folder at ${appDir(id)}`)
        throw error
      })
      for (const name of entries.sort()) {
        if (name.startsWith(".")) continue
        const path = prefix + name
        if (!SEGMENT.test(name)) throw new ViewStoreError(`${path}: file names may use letters, digits, ".", "_" and "-"`)
        const info = await lstat(join(dir, name))
        if (info.isSymbolicLink()) throw new ViewStoreError(`${path}: links are not allowed in a view`)
        if (info.isDirectory()) {
          if (depth >= VIEW_LIMITS.depth) throw new ViewStoreError(`${path}: folders nest at most ${VIEW_LIMITS.depth} deep`)
          await walk(join(dir, name), `${path}/`, depth + 1)
          continue
        }
        if (!info.isFile()) continue
        const data = DATA_EXTENSION.test(name)
        if (!data && !SOURCE_EXTENSIONS.test(name)) throw new ViewStoreError(`${path}: a view holds only .tsx, .ts, .jsx, .js, .css and .json files`)
        const limit = data ? VIEW_LIMITS.dataBytes : VIEW_LIMITS.sourceBytes
        if (info.size > limit) throw new ViewStoreError(`${path} is ${Math.ceil(info.size / 1024)} KB; the limit is ${limit / 1024} KB`)
        total += info.size
        if (total > VIEW_LIMITS.totalBytes) throw new ViewStoreError(`The view's files pass ${VIEW_LIMITS.totalBytes / 1024 / 1024} MB together`)
        if (files.length >= VIEW_LIMITS.files) throw new ViewStoreError(`A view holds at most ${VIEW_LIMITS.files} files`)
        files.push({ path, text: await readFile(join(dir, name), "utf8") })
      }
    }
    await walk(appDir(id), "", 1)
    return files
  }

  /** Stores a build as the next version, or returns the latest when it is the same page. */
  function addVersion(id: string, build: { files: ViewSourceFile[]; html: string; sessionId?: string; title?: string }): Promise<{ record: ViewRecord; version: ViewVersionMeta; created: boolean }> {
    const dir = folder(id)
    return exclusive(id, async () => {
      const record = await read(id)
      if (!record) throw new ViewStoreError(`No view "${id}"`)
      const hash = createHash("sha256").update(build.html).digest("hex")
      const latest = record.versions.at(-1)
      if (latest?.hash === hash && (!build.title || build.title === record.title)) return { record, version: latest, created: false }
      const version: ViewVersionMeta = { version: (latest?.version ?? 0) + 1, createdAt: new Date().toISOString(), hash, ...(build.sessionId ? { sessionId: build.sessionId } : {}) }
      const versionDir = join(dir, "versions", String(version.version))
      await mkdir(versionDir, { recursive: true })
      await writeFile(join(versionDir, "index.html"), build.html)
      await writeFile(join(versionDir, "files.json"), JSON.stringify(build.files))
      const next: ViewRecord = { ...record, title: build.title || record.title, updatedAt: version.createdAt, versions: [...record.versions, version] }
      await writeRecord(dir, next)
      return { record: next, version, created: true }
    })
  }

  /** Renames or pins a view; its versions and source stay as they are. */
  function update(id: string, change: ViewUpdate): Promise<ViewRecord> {
    const dir = folder(id)
    return exclusive(id, async () => {
      const record = await read(id)
      if (!record) throw new ViewStoreError(`No view "${id}"`)
      const title = change.title?.replace(/\s+/g, " ").trim()
      if (change.title !== undefined && (!title || title.length > MAX_TITLE)) throw new ViewStoreError(`A view's title is 1 to ${MAX_TITLE} characters`)
      const next: ViewRecord = { ...record, ...(title ? { title } : {}), ...(change.pinned === undefined ? {} : { pinned: change.pinned }) }
      await writeRecord(dir, next)
      return next
    })
  }

  /** Deletes a view's source and every version, leaving its tombstone. */
  function remove(id: string): Promise<boolean> {
    const dir = folder(id)
    return exclusive(id, async () => {
      const record = await read(id, { includeDeleted: true })
      if (!record) return false
      if (record.deleted) return true
      await Promise.all(["app", "versions"].map((name) => rm(join(dir, name), { recursive: true, force: true })))
      const tombstone: ViewRecord = { ...record, deleted: true, pinned: false, versions: [], updatedAt: new Date().toISOString() }
      await writeRecord(dir, tombstone)
      return true
    })
  }

  async function readVersion(id: string, version: number): Promise<{ record: ViewRecord; html: string; files: ViewSourceFile[] } | null> {
    const record = await read(id)
    if (!record?.versions.some((meta) => meta.version === version)) return null
    const versionDir = join(folder(id), "versions", String(version))
    const [html, files] = await Promise.all([readFile(join(versionDir, "index.html"), "utf8"), readFile(join(versionDir, "files.json"), "utf8")])
    return { record, html, files: JSON.parse(files) as ViewSourceFile[] }
  }

  return { root, appDir, read, create, list, readSources, addVersion, readVersion, update, remove }
}

let defaultStore: ViewStore | null = null

/** The store under `~/.cogpit/views` (or `COGPIT_VIEWS_HOME`, read on each call). */
export function viewStore(): ViewStore {
  const root = defaultViewsRoot()
  if (defaultStore?.root !== root) defaultStore = createViewStore(root)
  return defaultStore
}
