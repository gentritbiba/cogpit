import type { Dirent } from "node:fs"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { descriptorFor, isSessionUuid } from "../../shared/session/agent-descriptors"

/**
 * Background task output. Claude Code writes a background command's output to
 * `<tmp>/claude-<uid>/<project>/<sessionId>/tasks/<task>.output`, so the file
 * belongs to the session named in its path.
 */

// Windows has no /tmp, so nothing would ever pass containment there without %TEMP%.
const TASK_OUTPUT_BASES: readonly string[] = process.platform === "win32"
  ? [tmpdir()]
  : ["/private/tmp", "/tmp"]
const NAMESPACE_PREFIX = "claude-"
const TASKS_DIR = "tasks"
const OUTPUT_EXTENSION = ".output"

/** A background task's output file, and the session whose task writes it. */
export interface TaskOutput {
  /** Canonical. */
  path: string
  /** Lowercased; null for output filed under no session. */
  sessionId: string | null
}

/** A task output file as it is listed under a project, before anything is followed. */
export interface ListedTaskOutput {
  /** Lowercased. */
  sessionId: string
  fileName: string
  path: string
  isSymbolicLink: boolean
}

let canonicalBases: Promise<string[]> | null = null

function getCanonicalBases(): Promise<string[]> {
  canonicalBases ??= Promise.all(
    TASK_OUTPUT_BASES.map(async (base) => {
      try {
        return await realpath(base)
      } catch {
        return resolve(base)
      }
    }),
  ).then((bases) => [...new Set(bases)])
  return canonicalBases
}

/** The canonical form of a path that may not exist yet, or null when a symlink on the way is broken. */
async function canonicalizeIncludingMissing(path: string): Promise<string | null> {
  const missingSegments: string[] = []
  let cursor = path

  while (true) {
    let cursorInfo
    try {
      cursorInfo = await lstat(cursor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") return null
      const parent = dirname(cursor)
      if (parent === cursor) return null
      missingSegments.unshift(basename(cursor))
      cursor = parent
      continue
    }

    let canonicalCursor: string
    try {
      canonicalCursor = await realpath(cursor)
    } catch {
      // A broken symlink has an lstat result but no canonical destination.
      return null
    }

    if (missingSegments.length > 0) {
      try {
        const canonicalInfo = cursorInfo.isSymbolicLink()
          ? await stat(canonicalCursor)
          : cursorInfo
        if (!canonicalInfo.isDirectory()) return null
      } catch {
        return null
      }
    }

    return resolve(canonicalCursor, ...missingSegments)
  }
}

/**
 * Where `candidate` sits in a `claude-*` temp tree under `base`: null when it
 * is not inside one, else the session whose task directory holds it (null
 * for anywhere else in the tree).
 */
function placeInTree(base: string, candidate: string): { sessionId: string | null } | null {
  const child = relative(base, candidate)
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return null
  const [namespace, ...rest] = child.split(sep)
  if (!namespace.startsWith(NAMESPACE_PREFIX) || namespace.length === NAMESPACE_PREFIX.length || rest.length === 0) return null
  const [project, session, tasks, ...file] = rest
  const inSessionTasks = Boolean(project) && isSessionUuid(session ?? "") && tasks === TASKS_DIR && file.length > 0
  return { sessionId: inSessionTasks ? session.toLowerCase() : null }
}

/**
 * Background task output at `outputPath`: canonical and still inside a
 * `claude-*` temp tree once symlinks are followed, with the session whose task
 * directory holds it there; null for anything else. The file may not exist
 * yet, so a caller streaming it checks again before every read.
 */
export async function resolveTaskOutput(outputPath: string): Promise<TaskOutput | null> {
  const lexicalPath = resolve(outputPath)
  const bases = await getCanonicalBases()
  // The lexical pre-check accepts either spelling of a base, since a root can
  // reach the caller in a form os.tmpdir() does not use — /tmp vs /private/tmp
  // on macOS, an 8.3 short path vs its long form on Windows. Containment and
  // the owning session are decided by the canonical path below.
  const lexicalBases = [...new Set([...TASK_OUTPUT_BASES.map((base) => resolve(base)), ...bases])]
  if (!lexicalBases.some((base) => placeInTree(base, lexicalPath))) return null

  const path = await canonicalizeIncludingMissing(lexicalPath)
  if (!path) return null
  for (const base of bases) {
    const place = placeInTree(base, path)
    if (place) return { path, sessionId: place.sessionId }
  }
  return null
}

async function directoryEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** True for a directory that is not a symlink to one. */
async function isOwnDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every background task output Claude Code keeps for the project at `cwd`,
 * each with the session whose task directory lists it. Session and task
 * directories reached through a symlink are skipped, so each listed file
 * resolves to the session it is listed under.
 */
export async function listProjectTaskOutputs(cwd: string): Promise<ListedTaskOutput[]> {
  // Claude Code names its per-user directory after the uid, or 0 where there are no uids.
  const namespace = `${NAMESPACE_PREFIX}${process.getuid?.() ?? 0}`
  const project = descriptorFor("claude").dirName.encode(cwd)
  const outputs: ListedTaskOutput[] = []
  for (const base of await getCanonicalBases()) {
    const projectDir = join(base, namespace, project)
    for (const session of await directoryEntries(projectDir)) {
      if (!session.isDirectory() || !isSessionUuid(session.name)) continue
      const tasksDir = join(projectDir, session.name, TASKS_DIR)
      if (!await isOwnDirectory(tasksDir)) continue
      for (const entry of await directoryEntries(tasksDir)) {
        if (!entry.name.endsWith(OUTPUT_EXTENSION)) continue
        outputs.push({
          sessionId: session.name.toLowerCase(),
          fileName: entry.name,
          path: join(tasksDir, entry.name),
          isSymbolicLink: entry.isSymbolicLink(),
        })
      }
    }
  }
  return outputs
}
