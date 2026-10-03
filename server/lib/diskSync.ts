import { open } from "node:fs/promises"

/** Flush a file's bytes from the page cache to the disk, so a power loss after this resolves cannot take them. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+")
  try {
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

/** What a filesystem that cannot flush a directory answers when asked to. */
const DIRECTORY_FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EBADF"])

/**
 * Flush a directory's entries — a file created in it or renamed into it — to
 * the disk. Windows cannot open a directory to flush it, and some filesystems
 * cannot flush one; there this does nothing.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } catch (error) {
    if (!DIRECTORY_FLUSH_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error
  } finally {
    await handle.close()
  }
}
