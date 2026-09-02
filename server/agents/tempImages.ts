import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Image attachments, staged on disk for an agent that takes file paths rather
 * than inline data. The caller owns the returned paths and must hand them back
 * to `cleanupTempFiles` once the turn is over.
 */

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

export async function writeTempImageFiles(
  images?: Array<{ data: string; mediaType: string }>
): Promise<string[]> {
  if (!Array.isArray(images) || images.length === 0) return []

  const files: string[] = []
  for (const [index, image] of images.entries()) {
    const ext = IMAGE_EXT[image.mediaType] ?? "png"
    const filePath = join(tmpdir(), `cogpit-codex-image-${Date.now()}-${index}.${ext}`)
    await writeFile(filePath, Buffer.from(image.data, "base64"))
    files.push(filePath)
  }
  return files
}

export async function cleanupTempFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (filePath) => {
    try {
      await unlink(filePath)
    } catch {
      // ignore cleanup failures
    }
  }))
}
