import { existsSync, type Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))

/**
 * The team edition: a private package, checked out as the editions/team
 * submodule. A public clone has the directory but not the package, so the
 * package is there when its entry file is. Checks cover it when it is there
 * and must pass without it.
 */
export const TEAM_EDITION_ROOT = "editions/team"
export const TEAM_EDITION_ENTRY = `${TEAM_EDITION_ROOT}/index.ts`
/** The edition's renderer UI, which the `@cogpit/edition-ui` alias names when the package has one. */
export const TEAM_EDITION_UI_ENTRY = `${TEAM_EDITION_ROOT}/ui/index.ts`

export function teamEditionIn(checkout: string): boolean {
  return existsSync(join(checkout, TEAM_EDITION_ENTRY))
}

export const hasTeamEdition = teamEditionIn(root)

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"])
const buildDirectories = new Set(["dist", "out"])
/** The team package keeps its suite beside its sources rather than under `__tests__`. */
const testRoots = new Set([`${TEAM_EDITION_ROOT}/tests`])

export interface CollectOptions {
  /** Include test files and the directories that hold them. */
  tests?: boolean
}

export function relativePath(path: string): string {
  return relative(root, path).split(sep).join("/")
}

/** A directory that holds only test code, named by its absolute path. */
export function isTestDirectory(path: string): boolean {
  return basename(path) === "__tests__" || testRoots.has(relativePath(path))
}

/**
 * Collect every production source file under the given repo-relative roots,
 * and with `tests` every test file as well.
 *
 * A guard that audits less code than it thinks it does is worse than no guard,
 * so an unreadable top-level root is a hard error. Deeper directories stay
 * tolerant: they can vanish between listing a parent and reading the child
 * (build output, worktree churn), and skipping one of those is not the
 * silent-blind-spot failure this guards against.
 */
export async function collectSourceRoots(
  roots: readonly string[],
  options: CollectOptions = {},
): Promise<string[]> {
  const collected = await Promise.all(roots.map(async (name) => {
    const directory = join(root, name)
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      throw new Error(`Source root "${name}" is missing or unreadable`, { cause })
    })
    return collectEntries(directory, entries, options)
  }))
  return collected.flat()
}

async function collectSubdirectory(directory: string, options: CollectOptions): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return collectEntries(directory, entries, options)
}

async function collectEntries(directory: string, entries: Dirent[], options: CollectOptions): Promise<string[]> {
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const skipped = buildDirectories.has(entry.name) || (!options.tests && isTestDirectory(path))
      return skipped ? [] : collectSubdirectory(path, options)
    }
    if (!sourceExtensions.has(extname(entry.name))) return []
    return options.tests || !entry.name.includes(".test.") ? [path] : []
  }))
  return files.flat()
}
