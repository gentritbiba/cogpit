import { mkdir, realpath, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ErrorCodes, RouteError } from "../lib/routeError"
import { serialQueue, type SerialQueue } from "../lib/serialQueue"
import { isWithinDir } from "../pathSafety"
import { createBundle, fetchBundle, type TransferBundle } from "./bundle"
import { git, GitCommandError, gitSucceeds, GIT_TRANSFER_TIMEOUT_MS } from "./git"
import { COMMIT_SHA_RE, REPO_KEY_RE, snapshotWorkspace } from "./snapshot"

/** Starts alphanumeric or `_`, so no task name is hidden, an option, or a dot segment. */
export const TASK_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/
const MAX_TASK_NAME_LENGTH = 64
const BARE_REPO_DIR = "repo.git"

export interface ImportWorkspaceInput {
  repoKey: string
  /** null when the device already has `snapshot` (see knownCommits). */
  bundlePath: string | null
  /** The ref inside the bundle; required with bundlePath. */
  bundleRef: string | null
  snapshot: string
  task: string
  /** posix path relative to the repository root, "" for the root. */
  subdir: string
}

export interface ImportedWorkspace {
  /** `<repoKey>/<task>` */
  workspaceId: string
  /** The worktree root. */
  path: string
  /** path + subdir, where the agent should start. */
  cwd: string
  branch: string
}

export interface ExportedWorkspace {
  tip: string
  dirty: boolean
  /** null when the receiver already has `tip`. */
  bundle: TransferBundle | null
}

export function workspacesRoot(): string {
  return process.env.COGPIT_WORKSPACES_DIR || join(homedir(), ".cogpit", "workspaces")
}

function invalid(message: string): RouteError {
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, message)
}

export function isValidTaskName(name: string): boolean {
  return TASK_NAME_RE.test(name)
    && !name.includes("..")
    && !name.endsWith(".")
    && !name.endsWith(".lock")
    && name !== BARE_REPO_DIR
}

/** Turn any label into a task name that is also a valid git branch component. */
export function sanitizeTaskName(label: string): string {
  const slug = label
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, MAX_TASK_NAME_LENGTH)
    .replace(/(?:\.lock)+$/i, "")
    .replace(/[.-]+$/, "")
  return slug || "task"
}

export function isValidSubdir(subdir: string): boolean {
  if (subdir === "") return true
  if (subdir.includes("\0") || subdir.includes("\\")) return false
  return subdir.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

/** Refs a bundle may carry: git's ref grammar, minus anything a refspec would reinterpret. */
export function isValidBundleRef(ref: string): boolean {
  return /^refs\/[A-Za-z0-9._/-]+$/.test(ref)
    && !ref.includes("..")
    && !ref.includes("//")
    && !ref.endsWith("/")
    && !ref.endsWith(".lock")
}

function repoDirFor(repoKey: string): string {
  return join(workspacesRoot(), repoKey, BARE_REPO_DIR)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

interface WorkspaceLocation {
  repoKey: string
  task: string
  path: string
  repoDir: string
}

function locateWorkspace(workspaceId: string): WorkspaceLocation {
  const parts = typeof workspaceId === "string" ? workspaceId.split("/") : []
  const [repoKey, task] = parts
  if (parts.length !== 2 || !REPO_KEY_RE.test(repoKey) || !isValidTaskName(task)) {
    throw invalid("workspaceId must be <repoKey>/<task>")
  }
  const root = workspacesRoot()
  const path = resolve(root, repoKey, task)
  if (!isWithinDir(root, path)) throw invalid("workspaceId escapes the workspaces folder")
  return { repoKey, task, path, repoDir: repoDirFor(repoKey) }
}

// Imports into one repository share its bare repo, and picking a free task
// name then claiming it must not interleave with another import.
const repoQueues = new Map<string, SerialQueue>()

function queueFor(repoKey: string): SerialQueue {
  let queue = repoQueues.get(repoKey)
  if (!queue) {
    queue = serialQueue()
    repoQueues.set(repoKey, queue)
  }
  return queue
}

/** Every ref tip in the device's copy of the repository, for the sender to exclude. */
export async function knownCommits(repoKey: string): Promise<string[]> {
  if (!REPO_KEY_RE.test(repoKey)) throw invalid("Invalid repoKey")
  const repoDir = repoDirFor(repoKey)
  if (!(await exists(repoDir))) return []
  const output = await git(repoDir, ["for-each-ref", "--format=%(objectname)"])
  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))]
}

async function claimTaskName(repoDir: string, taskRoot: string, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`
    const candidate = `${base.slice(0, MAX_TASK_NAME_LENGTH - suffix.length)}${suffix}`
    if (!isValidTaskName(candidate)) continue
    if (await exists(join(taskRoot, candidate))) continue
    if (await gitSucceeds(repoDir, ["rev-parse", "--verify", "-q", `refs/heads/cogpit/${candidate}`])) continue
    return candidate
  }
  throw new RouteError(409, ErrorCodes.CONFLICT, `No free workspace name left for ${base}`)
}

/** Check a sent snapshot out as a fresh worktree on its own `cogpit/<task>` branch. */
export async function importWorkspace(input: ImportWorkspaceInput): Promise<ImportedWorkspace> {
  const { repoKey, bundlePath, bundleRef, snapshot, subdir } = input
  if (!REPO_KEY_RE.test(repoKey)) throw invalid("Invalid repoKey")
  if (!COMMIT_SHA_RE.test(snapshot)) throw invalid("snapshot must be a commit sha")
  if (!isValidSubdir(subdir)) throw invalid("subdir must be a relative path inside the repository")
  if (bundlePath && (!bundleRef || !isValidBundleRef(bundleRef))) throw invalid("Invalid bundleRef")

  return queueFor(repoKey).run(async () => {
    const taskRoot = join(workspacesRoot(), repoKey)
    const repoDir = repoDirFor(repoKey)
    if (!(await exists(repoDir))) {
      await mkdir(taskRoot, { recursive: true })
      await git(taskRoot, ["init", "--quiet", "--bare", BARE_REPO_DIR])
    }

    const task = await claimTaskName(repoDir, taskRoot, sanitizeTaskName(input.task))
    const importRef = `refs/cogpit/imports/${task}`
    const branch = `cogpit/${task}`
    const path = join(taskRoot, task)

    if (bundlePath && bundleRef) {
      await fetchBundle(repoDir, bundlePath, bundleRef, importRef).catch((error: unknown) => {
        if (error instanceof GitCommandError) throw invalid(`Could not read the bundle: ${error.stderr}`)
        throw error
      })
    }
    if (!(await gitSucceeds(repoDir, ["cat-file", "-e", `${snapshot}^{commit}`]))) {
      await git(repoDir, ["update-ref", "-d", importRef]).catch(() => undefined)
      throw bundlePath
        ? invalid("The bundle does not contain the snapshot commit")
        : new RouteError(409, ErrorCodes.CONFLICT, "This device does not have the snapshot; send a bundle")
    }
    if (!bundlePath) await git(repoDir, ["update-ref", importRef, snapshot])

    try {
      await git(repoDir, ["worktree", "add", "--quiet", "-b", branch, path, snapshot], {
        timeout: GIT_TRANSFER_TIMEOUT_MS,
      })
    } catch (error) {
      await git(repoDir, ["update-ref", "-d", importRef]).catch(() => undefined)
      throw error
    }

    const cwd = subdir ? join(path, ...subdir.split("/")) : path
    await mkdir(cwd, { recursive: true })
    return { workspaceId: `${repoKey}/${task}`, path, cwd, branch }
  })
}

/**
 * A folder under the workspaces root that is not itself a worktree must not
 * resolve to whatever repository happens to contain the root.
 */
async function isWorktreeRoot(path: string): Promise<boolean> {
  if (!(await exists(path))) return false
  try {
    const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim()
    return await realpath(top) === await realpath(path)
  } catch {
    return false
  }
}

/**
 * Freeze a workspace's result, uncommitted work included, and bundle it minus
 * the `exclude` commits the receiver already has. The caller owns the bundle.
 */
export async function exportWorkspace(workspaceId: string, exclude: readonly string[]): Promise<ExportedWorkspace> {
  const { path } = locateWorkspace(workspaceId)
  if (exclude.some((sha) => !COMMIT_SHA_RE.test(sha))) throw invalid("exclude must list commit shas")
  if (!(await isWorktreeRoot(path))) throw new RouteError(404, ErrorCodes.NOT_FOUND, "Workspace not found")

  const snapshot = await snapshotWorkspace(path)
  const bundle = await createBundle(snapshot.repoRoot, snapshot.snapshot, exclude)
  return { tip: snapshot.snapshot, dirty: snapshot.dirty, bundle }
}

/** Remove a workspace's worktree, branch and import ref. Missing pieces are fine. */
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const { repoKey, task, path, repoDir } = locateWorkspace(workspaceId)
  if (!(await exists(repoDir))) return
  await queueFor(repoKey).run(async () => {
    if (await exists(path)) {
      await git(repoDir, ["worktree", "remove", "--force", path]).catch(() => rm(path, { recursive: true, force: true }))
    }
    await git(repoDir, ["worktree", "prune"])
    await git(repoDir, ["branch", "-D", `cogpit/${task}`]).catch(() => undefined)
    await git(repoDir, ["update-ref", "-d", `refs/cogpit/imports/${task}`]).catch(() => undefined)
  })
}
