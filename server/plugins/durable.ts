import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseJsonText } from "./json"

export const STORE_DOCUMENT_LIMIT = 32 * 1024 * 1024
export const isWriteTemporary = (name: string): boolean => /^\.write-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin store directory is not a real directory")
}
export async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!(process.platform === "win32" && ["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"].includes(code ?? ""))) throw error
  } finally { await handle?.close() }
}
export async function regularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Plugin store file is not a regular file")
  if (stat.size > STORE_DOCUMENT_LIMIT) throw new Error("Plugin store file exceeds its size limit")
  return readFile(path)
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}
export async function durableWrite(path: string, bytes: Buffer, options: { label: string; guard: () => Promise<void>; hook?: (step: string) => void | Promise<void> }): Promise<void> {
  const temporary = join(dirname(path), `.write-${randomUUID()}.tmp`)
  let handle
  try {
    await options.guard()
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = undefined
    await options.hook?.(`${options.label}:file-synced`)
    await options.guard()
    await rename(temporary, path)
    await options.hook?.(`${options.label}:renamed`)
    await syncDirectory(dirname(path))
    await options.hook?.(`${options.label}:directory-synced`)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}
export function documentBytes(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value))
  parseJsonText(bytes, STORE_DOCUMENT_LIMIT)
  return bytes
}
export async function removeDurably(path: string): Promise<void> {
  await rm(path, { force: true })
  await syncDirectory(dirname(path))
}
