import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"

export const root = resolve(import.meta.dir, "../..")

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"])
const skippedDirectories = new Set(["__tests__", "dist", "out"])

export function relativePath(path: string): string {
  return relative(root, path).split(sep).join("/")
}

/**
 * Collect every production source file under the given repo-relative roots.
 *
 * A guard that audits less code than it thinks it does is worse than no guard,
 * so an unreadable top-level root is a hard error. Deeper directories stay
 * tolerant: they can vanish between listing a parent and reading the child
 * (build output, worktree churn), and skipping one of those is not the
 * silent-blind-spot failure this guards against.
 */
export async function collectSourceRoots(roots: readonly string[]): Promise<string[]> {
  const collected = await Promise.all(roots.map(async (name) => {
    const directory = join(root, name)
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      throw new Error(`Source root "${name}" is missing or unreadable`, { cause })
    })
    return collectEntries(directory, entries)
  }))
  return collected.flat()
}

async function collectSubdirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return collectEntries(directory, entries)
}

async function collectEntries(directory: string, entries: Dirent[]): Promise<string[]> {
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) ? [] : collectSubdirectory(path)
    }
    if (!sourceExtensions.has(extname(entry.name)) || entry.name.includes(".test.")) return []
    return [path]
  }))
  return files.flat()
}
