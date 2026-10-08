/** Bundles in flight between a hub and this device, staged in the temp folder. */

import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WORKSPACE_UPLOAD_MAX_BYTES } from "../../shared/contracts/workspaces"
import { ErrorCodes, RouteError } from "../lib/routeError"
import { serialQueue } from "../lib/serialQueue"
import type { TransferBundle } from "./bundle"

export const TRANSFER_TTL_MS = 60 * 60_000
export const TRANSFER_ID_RE = /^[0-9a-f]{32}$/

function uploadsDir(): string {
  return join(tmpdir(), "cogpit-workspace-uploads")
}

function downloadsDir(): string {
  return join(tmpdir(), "cogpit-workspace-downloads")
}

function newTransferId(): string {
  return randomBytes(16).toString("hex")
}

function transferFile(dir: string, id: string): string {
  if (!TRANSFER_ID_RE.test(id)) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid transfer id")
  return join(dir, `${id}.bundle`)
}

async function sizeOf(path: string): Promise<number | null> {
  return stat(path).then((info) => info.size, () => null)
}

// Appends read the current size and then write, and opening an upload counts
// the open ones and then adds one, so neither may interleave with another.
const uploadQueue = serialQueue()

/** Open uploads at once; each may grow to the upload cap, so this bounds the disk they take. */
export const MAX_OPEN_UPLOADS = 8

export function createUpload(): Promise<string | null> {
  return uploadQueue.run(async () => {
    await mkdir(uploadsDir(), { recursive: true, mode: 0o700 })
    if ((await readdir(uploadsDir())).length >= MAX_OPEN_UPLOADS) return null
    const id = newTransferId()
    await writeFile(transferFile(uploadsDir(), id), "", { mode: 0o600, flag: "wx" })
    return id
  })
}

export type AppendResult =
  | { status: "stored"; size: number }
  | { status: "offset-mismatch"; size: number }
  | { status: "too-large"; size: number }

/**
 * Append `chunk` at `offset`. A chunk the upload already holds is a retry
 * and succeeds without writing; any other offset gap or overlap is a mismatch.
 */
export function appendUpload(id: string, offset: number, chunk: Buffer): Promise<AppendResult> {
  const path = transferFile(uploadsDir(), id)
  return uploadQueue.run(async () => {
    const size = await sizeOf(path)
    if (size === null) throw new RouteError(404, ErrorCodes.NOT_FOUND, "Upload not found or expired")
    if (offset < size && offset + chunk.byteLength <= size) return { status: "stored", size }
    if (offset !== size) return { status: "offset-mismatch", size }
    if (size + chunk.byteLength > WORKSPACE_UPLOAD_MAX_BYTES) return { status: "too-large", size }
    await appendFile(path, chunk)
    return { status: "stored", size: size + chunk.byteLength }
  })
}

/** The finished upload's file, or a 404 when it expired or never existed. */
export async function uploadedBundlePath(id: string): Promise<string> {
  const path = transferFile(uploadsDir(), id)
  if ((await sizeOf(path)) === null) throw new RouteError(404, ErrorCodes.NOT_FOUND, "Upload not found or expired")
  return path
}

export async function deleteUpload(id: string): Promise<void> {
  await rm(transferFile(uploadsDir(), id), { force: true })
}

const downloadRefs = new Map<string, string>()

/** Take ownership of a bundle and return the id it can be downloaded under. */
export async function stageDownload(bundle: TransferBundle): Promise<string> {
  const id = newTransferId()
  await mkdir(downloadsDir(), { recursive: true })
  await rename(bundle.path, transferFile(downloadsDir(), id))
  downloadRefs.set(id, bundle.ref)
  return id
}

export async function stagedDownload(id: string): Promise<(TransferBundle & { size: number }) | null> {
  const ref = downloadRefs.get(id)
  const path = transferFile(downloadsDir(), id)
  const size = await sizeOf(path)
  if (!ref || size === null) return null
  return { path, ref, size }
}

export async function deleteDownload(id: string): Promise<void> {
  downloadRefs.delete(id)
  await rm(transferFile(downloadsDir(), id), { force: true })
}

async function removeStale(dir: string, cutoff: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [])
  const removed: string[] = []
  await Promise.all(names.map(async (name) => {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info || info.mtimeMs >= cutoff) return
    await rm(path, { force: true })
    removed.push(name.replace(/\.bundle$/, ""))
  }))
  return removed
}

/**
 * Delete uploads idle and downloads unclaimed for longer than the TTL,
 * including files left behind by an earlier server process.
 */
export async function sweepExpiredTransfers(now = Date.now()): Promise<void> {
  const cutoff = now - TRANSFER_TTL_MS
  await removeStale(uploadsDir(), cutoff)
  for (const id of await removeStale(downloadsDir(), cutoff)) downloadRefs.delete(id)
}
