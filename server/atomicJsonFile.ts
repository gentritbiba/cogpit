import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"

/**
 * Atomically replace a JSON file from a same-directory owner-only temporary.
 * Readers therefore observe either the previous complete value or the new one,
 * never a truncated write after a crash or concurrent read.
 */
export async function writeOwnerOnlyText(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf-8",
      mode,
    })
    await chmod(temporaryPath, mode)
    await rename(temporaryPath, filePath)
    await chmod(filePath, mode)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary may not have been created or may already have moved.
    }
    throw error
  }
}

export async function writeOwnerOnlyJson(
  filePath: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await writeOwnerOnlyText(filePath, JSON.stringify(value, null, 2), mode)
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
): Promise<Map<string, T>> {
  const loaded = new Map<string, T>()

  let raw: string
  try {
    raw = await readFile(filePath, "utf-8")
    await chmod(filePath, 0o600)
  } catch {
    return loaded
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const value = normalize(entry)
        if (value) loaded.set(keyOf(value), value)
      }
    }
  } catch {
    // Corrupt JSON → start empty rather than crashing the shell.
  }
  return loaded
}
