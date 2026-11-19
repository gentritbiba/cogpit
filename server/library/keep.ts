/**
 * Copies the local files replies shared into the library, by content hash,
 * so a screenshot under /tmp survives the next reboot and a path an agent
 * writes again keeps each version it showed. Newest first, within per-file
 * limits and an overall quota that drops the oldest copies to make room.
 */
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { extensionOf } from "../../shared/library/extract"
import type { LibraryKeepState } from "../../shared/library/types"
import type { LibraryStore, PendingKeep } from "./store"

const MB = 1024 * 1024

export interface KeepLimits {
  /** Largest file of each kind worth a copy. */
  image: number
  video: number
  file: number
  /** All copies together. */
  quota: number
}

export const KEEP_LIMITS: KeepLimits = Object.freeze({ image: 25 * MB, video: 250 * MB, file: 25 * MB, quota: 2048 * MB })

/** A file written this long after the reply that shared it is not what the reply showed. */
const CHANGED_AFTER_MS = 2 * 60_000
const BATCH = 50
const INCOMING = ".incoming-"

export interface KeepOptions {
  limits?: KeepLimits
  pause?: () => Promise<void>
  signal?: AbortSignal
}

export function keptFilePath(filesDir: string, hash: string, ext: string): string {
  return join(filesDir, `${hash}${ext}`)
}

/** Folders whose copies an earlier process left half made were cleared; once per folder per process. */
const swept = new Set<string>()

/** Removes copies a process stopped in the middle of; none of this process's is in flight between runs. */
async function sweepIncoming(filesDir: string): Promise<void> {
  if (swept.has(filesDir)) return
  swept.add(filesDir)
  const names = await readdir(filesDir).catch(() => [])
  await Promise.all(names.filter((name) => name.startsWith(INCOMING)).map((name) => rm(join(filesDir, name), { force: true })))
}

/** Looks at every local file not yet looked at; answers how many it kept. Runs one at a time. */
export async function keepPending(store: LibraryStore, filesDir: string, options: KeepOptions = {}): Promise<number> {
  const limits = options.limits ?? KEEP_LIMITS
  let kept = 0
  let madeDir = false
  for (;;) {
    const pending = store.pendingKeeps(BATCH)
    if (pending.length === 0) return kept
    for (const item of pending) {
      if (options.signal?.aborted) return kept
      if (!madeDir) {
        await mkdir(filesDir, { recursive: true, mode: 0o700 })
        await sweepIncoming(filesDir)
        madeDir = true
      }
      if (await keepOne(store, filesDir, item, limits)) kept++
      await options.pause?.()
    }
  }
}

async function keepOne(store: LibraryStore, filesDir: string, item: PendingKeep, limits: KeepLimits): Promise<boolean> {
  let info
  try {
    info = await stat(item.target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return mark(store, item, code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed")
  }
  if (!info.isFile()) return mark(store, item, "missing")
  if (info.size > limits[item.kind]) return mark(store, item, "too-large")
  if (item.sharedMs !== null && info.mtimeMs > item.sharedMs + CHANGED_AFTER_MS) return mark(store, item, "changed")

  const ext = extensionOf(item.target)
  const incoming = join(filesDir, `${INCOMING}${randomUUID()}`)
  let copied: { hash: string; size: number }
  try {
    copied = await copyHashed(item.target, incoming, limits[item.kind])
  } catch {
    await rm(incoming, { force: true })
    return mark(store, item, "failed")
  }

  const existing = store.keptFile(copied.hash)
  if (existing) {
    // Recorded before the next await, so a removal meanwhile cannot delete the copy this now points at.
    store.keep(item.id, existing)
    await rm(incoming, { force: true })
    return true
  }
  if (!(await makeRoom(store, filesDir, copied.size, item.sharedMs ?? 0, limits.quota))) {
    await rm(incoming, { force: true })
    return mark(store, item, "evicted")
  }
  await rename(incoming, keptFilePath(filesDir, copied.hash, ext))
  store.keep(item.id, { hash: copied.hash, ext, size: copied.size })
  return true
}

function mark(store: LibraryStore, item: PendingKeep, state: Exclude<LibraryKeepState, "kept">): false {
  store.setKeepState(item.id, state)
  return false
}

/** Copies `source` to `destination` while hashing it, refusing one that grows past `limit` meanwhile. */
async function copyHashed(source: string, destination: string, limit: number): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256")
  let size = 0
  await pipeline(
    createReadStream(source),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > limit) throw new Error("grew past the limit while copying")
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(destination, { mode: 0o600 }),
  )
  return { hash: hash.digest("hex"), size }
}

/** Drops copies older than `sharedMs` until `size` more bytes fit; false when only newer ones are left. */
async function makeRoom(store: LibraryStore, filesDir: string, size: number, sharedMs: number, quota: number): Promise<boolean> {
  if (size > quota) return false
  let used = store.keptBytes()
  if (used + size <= quota) return true
  for (const file of store.keptByAge()) {
    if (file.newestMs >= sharedMs) return false
    await rm(keptFilePath(filesDir, file.hash, file.ext), { force: true })
    store.dropKept(file.hash)
    used -= file.size
    if (used + size <= quota) return true
  }
  return false
}
