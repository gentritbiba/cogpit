import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { isWithinDir } from "../pathSafety"
import { resolveGitProject } from "./gitProject"

/** Canonical path of an existing directory, or null when the path is missing, relative or not a directory. */
export async function canonicalDirectory(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd)) return null
  try {
    const root = await realpath(resolve(cwd))
    return (await stat(root)).isDirectory() ? root : null
  } catch {
    return null
  }
}

/**
 * Probe `root`, then each parent up to and including its Git worktree root.
 * Sibling apps, other worktrees and directories above the repository are never
 * consulted; a directory outside any repository is probed alone.
 */
export async function findNearestProjectRoot<T>(
  root: string,
  probe: (directory: string) => Promise<T | null>,
  signal?: AbortSignal,
): Promise<{ root: string; value: T } | null> {
  signal?.throwIfAborted()
  const exact = await probe(root)
  if (exact !== null) return { root, value: exact }
  const repository = await resolveGitProject(root, signal)
  signal?.throwIfAborted()
  if (!repository.ok || !repository.root || !isWithinDir(repository.root, root)) return null
  let directory = root
  while (directory !== repository.root) {
    directory = dirname(directory)
    signal?.throwIfAborted()
    const value = await probe(directory)
    if (value !== null) return { root: directory, value }
  }
  return null
}
