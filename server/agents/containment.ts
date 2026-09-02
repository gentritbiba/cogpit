import { lstat, realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { isWithinDir } from "../pathSafety"

/**
 * Path-safety primitives shared by every agent store.
 *
 * Session files are addressed by a `{dirName, fileName}` pair that arrives
 * straight from a URL, so every store resolves those against its own storage
 * root through the same containment check rather than each inventing one.
 */

/** True when `value` names one directory entry and cannot traverse upward. */
export function isSinglePathSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
}

/**
 * Resolve `filePath` only if it really lives inside `requestedRoot`, which must
 * itself live inside `storageRoot` — before *and after* symlinks are followed.
 *
 * The lexical check alone is not enough: a session directory or transcript can
 * be a symlink pointing anywhere on the filesystem, and its textual path still
 * looks contained. The returned path is the lexically resolved one, not the
 * canonical one, so callers keep addressing the file the way the agent wrote it.
 */
export async function resolveCanonicalFileWithinRoot(
  storageRoot: string,
  requestedRoot: string,
  filePath: string,
): Promise<string | null> {
  const resolvedStorageRoot = resolve(storageRoot)
  const resolvedRequestedRoot = resolve(requestedRoot)
  const resolvedFilePath = resolve(filePath)

  if (!isWithinDir(resolvedStorageRoot, resolvedRequestedRoot)) return null
  if (resolvedFilePath === resolvedRequestedRoot || !isWithinDir(resolvedRequestedRoot, resolvedFilePath)) {
    return null
  }

  try {
    const [canonicalStorageRoot, canonicalRequestedRoot, canonicalFilePath] = await Promise.all([
      realpath(resolvedStorageRoot),
      realpath(resolvedRequestedRoot),
      realpath(resolvedFilePath),
    ])
    if (!isWithinDir(canonicalStorageRoot, canonicalRequestedRoot)) return null
    if (!isWithinDir(canonicalRequestedRoot, canonicalFilePath)) return null
    return resolvedFilePath
  } catch {
    return null
  }
}

/** Size and mtime of a listed transcript, once it is known to be contained. */
export interface ListedFileStats {
  mtimeMs: number
  size: number
}

/**
 * Stat a candidate transcript found by walking a store's own root, rejecting
 * anything that is not a regular file or that escapes the root through a
 * symlink.
 *
 * `lstat` rather than `stat` so the symlink case is visible: only then is the
 * full canonical containment check worth its extra syscalls, which matters
 * because the activity monitor re-walks these roots every few seconds.
 */
export async function statContainedFile(
  storageRoot: string,
  filePath: string,
): Promise<ListedFileStats | null> {
  try {
    const entryStat = await lstat(filePath)
    if (entryStat.isFile()) return { mtimeMs: entryStat.mtimeMs, size: entryStat.size }
    if (!entryStat.isSymbolicLink()) return null

    const contained = await resolveCanonicalFileWithinRoot(storageRoot, storageRoot, filePath)
    if (!contained) return null
    const targetStat = await stat(contained)
    return targetStat.isFile() ? { mtimeMs: targetStat.mtimeMs, size: targetStat.size } : null
  } catch {
    return null
  }
}
