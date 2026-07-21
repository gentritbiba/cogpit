import { chmod, rename, unlink, writeFile } from "node:fs/promises"
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
