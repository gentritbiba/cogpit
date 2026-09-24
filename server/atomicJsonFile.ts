import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { syncDirectory, syncFile } from "./lib/diskSync"
import { sha256Hex } from "./lib/sha256"

export interface OwnerOnlyWriteOptions {
  /**
   * Flush the new bytes to the disk before the rename, and the directory's
   * entry after it: a power loss can then neither leave the file empty nor,
   * once the directory flush lands, take the write back.
   */
  durable?: boolean
}

/**
 * Atomically replace a JSON file from a same-directory owner-only temporary.
 * Readers therefore observe either the previous complete value or the new one,
 * never a truncated write after a crash or concurrent read. The temporary gets
 * its final mode before the rename, which carries it to `filePath`. Once the
 * rename lands the write has taken effect, so a durable write whose directory
 * then cannot be flushed only warns.
 */
export async function writeOwnerOnlyText(
  filePath: string,
  content: string,
  mode = 0o600,
  { durable = false }: OwnerOnlyWriteOptions = {},
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf-8",
      mode,
    })
    await chmod(temporaryPath, mode)
    if (durable) await syncFile(temporaryPath)
    await rename(temporaryPath, filePath)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary may not have been created or may already have moved.
    }
    throw error
  }
  if (!durable) return
  try {
    await syncDirectory(dirname(filePath))
  } catch (error) {
    console.warn(`[cogpit] Wrote ${filePath}, but could not flush its directory; a power loss may undo the write:`, error)
  }
}

/** Resolves the text written. */
export async function writeOwnerOnlyJson(
  filePath: string,
  value: unknown,
  mode = 0o600,
  options: OwnerOnlyWriteOptions = {},
): Promise<string> {
  const content = JSON.stringify(value, null, 2)
  await writeOwnerOnlyText(filePath, content, mode, options)
  return content
}

/** Records loaded from a file, and the sha256 of the bytes they were read from (null when none were). */
export interface LoadedRecords<T> {
  records: Map<string, T>
  sha256: string | null
}

/**
 * Load a JSON array of records into a keyed map. The chmod shares the read's
 * try block, so a file that cannot be repaired to owner-only mode yields an
 * empty map rather than loading secrets out of a world-readable file. A missing
 * or corrupt file yields an empty map too.
 */
export async function readOwnerOnlyJsonArray<T>(
  filePath: string,
  normalize: (entry: unknown) => T | null,
  keyOf: (value: T) => string,
): Promise<LoadedRecords<T>> {
  const records = new Map<string, T>()

  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
    await chmod(filePath, 0o600)
  } catch {
    return { records, sha256: null }
  }

  try {
    const parsed = JSON.parse(bytes.toString("utf-8"))
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const value = normalize(entry)
        if (value) records.set(keyOf(value), value)
      }
    }
  } catch {
    // Corrupt JSON → start empty rather than crashing the shell.
  }
  return { records, sha256: sha256Hex(bytes) }
}
