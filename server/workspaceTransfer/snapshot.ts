import { createHash, randomBytes } from "node:crypto"
import { copyFile, rm, stat, utimes } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { ErrorCodes, RouteError } from "../lib/routeError"
import { COGPIT_GIT_IDENTITY, git, GitCommandError } from "./git"

/** HEAD plus every uncommitted change of a repository, frozen as one commit. */
export interface WorkspaceSnapshot {
  repoRoot: string
  /** The requested cwd relative to repoRoot, posix separators, "" at the root. */
  subdir: string
  head: string
  /** null when HEAD is detached. */
  branch: string | null
  /** `head` when the tree is clean, otherwise a commit whose parent is `head`. */
  snapshot: string
  dirty: boolean
  repoKey: string
  repoName: string
}

/** `<repoName>-<10 hex>`; the name starts alphanumeric so a key is always a safe directory name. */
export const REPO_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}-[0-9a-f]{10}$/
export const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/

const SNAPSHOT_MESSAGE = "Cogpit snapshot: uncommitted changes"

function invalid(message: string): RouteError {
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, message)
}

/**
 * Reduce a remote URL to `host/owner/repo` so every spelling of one remote
 * (`git@host:o/r.git`, `ssh://git@host/o/r`, `https://user:token@host/o/r/`)
 * yields the same string.
 */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim()
  let host = ""
  let path = trimmed
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed)
  if (scheme) {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname.toLowerCase()
      path = decodeURIComponent(parsed.pathname)
    } catch {
      path = trimmed.slice(scheme[0].length)
    }
  } else {
    const scpLike = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(trimmed)
    if (scpLike) {
      host = scpLike[1].toLowerCase()
      path = scpLike[2]
    }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "")
  return host ? `${host}/${path}` : path
}

export function sanitizeRepoName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 64)
  return cleaned || "repo"
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10)
}

/**
 * The name comes from the origin path when there is one, so a repository
 * cloned into differently named folders still gets one key everywhere.
 */
async function identifyRepo(repoRoot: string, originUrl: string | null) {
  if (originUrl) {
    const normalized = normalizeRemoteUrl(originUrl)
    const repoName = sanitizeRepoName(normalized.split("/").pop() || basename(repoRoot))
    return { repoName, repoKey: `${repoName}-${shortHash(normalized)}` }
  }
  const repoName = sanitizeRepoName(basename(repoRoot))
  const rootCommit = (await git(repoRoot, ["rev-list", "--max-parents=0", "HEAD"])).split("\n")[0]
  return { repoName, repoKey: `${repoName}-${rootCommit.slice(0, 10)}` }
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim() || null
  } catch (error) {
    if (error instanceof GitCommandError) return null
    throw error
  }
}

/**
 * Hash the working tree into a tree object through a throwaway index. Copying
 * the real index first keeps its stat cache, so only changed files get hashed,
 * and the user's own index and staged state are never written. The copy keeps
 * the index's own mtime too: git re-reads any file modified no earlier than
 * the index was written, and a fresh mtime would skip a same-size edit made in
 * that same second.
 */
async function writeWorkingTree(repoRoot: string): Promise<string> {
  const indexPath = resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-path", "index"])).trim())
  const scratchIndex = `${indexPath}.cogpit-${randomBytes(6).toString("hex")}`
  const env = { GIT_INDEX_FILE: scratchIndex }
  try {
    try {
      await copyFile(indexPath, scratchIndex)
      const { atime, mtime } = await stat(indexPath)
      await utimes(scratchIndex, atime, mtime)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await git(repoRoot, ["read-tree", "HEAD"], { env })
    }
    await git(repoRoot, ["add", "-A"], { env, timeout: 10 * 60_000 })
    return (await git(repoRoot, ["write-tree"], { env })).trim()
  } finally {
    await Promise.all([rm(scratchIndex, { force: true }), rm(`${scratchIndex}.lock`, { force: true })])
  }
}

/**
 * The commit holding uncommitted work. It takes its parent's date rather than
 * the clock, so the same work always makes the same commit — which is how a
 * hub asking for a workspace's work again sees that nothing changed.
 */
async function snapshotCommit(repoRoot: string, tree: string, head: string): Promise<string> {
  const date = `@${(await git(repoRoot, ["show", "-s", "--format=%ct", head])).trim()} +0000`
  return (await git(
    repoRoot,
    ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", SNAPSHOT_MESSAGE],
    { env: { ...COGPIT_GIT_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  )).trim()
}

/**
 * Capture HEAD plus staged, unstaged and untracked-but-not-ignored changes as
 * one commit, without touching the index or the working tree.
 */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const directory = await stat(cwd).catch(() => null)
  if (!directory?.isDirectory()) throw invalid(`${cwd} is not an existing directory`)

  let location: string[]
  try {
    location = (await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"])).split("\n")
  } catch (error) {
    if (error instanceof GitCommandError) throw invalid(`${cwd} is not inside a git repository`)
    throw error
  }
  const repoRoot = resolve(location[0].trim())
  const subdir = (location[1] ?? "").trim().replace(/\/+$/, "")

  const head = await optionalGit(repoRoot, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])
  if (!head) {
    throw invalid("This repository has no commits yet; commit at least once before sending this repo to another machine")
  }
  const [branch, origin, headTree, tree] = await Promise.all([
    optionalGit(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]),
    optionalGit(repoRoot, ["remote", "get-url", "origin"]),
    git(repoRoot, ["rev-parse", `${head}^{tree}`]).then((output) => output.trim()),
    writeWorkingTree(repoRoot),
  ])

  const dirty = tree !== headTree
  const snapshot = dirty ? await snapshotCommit(repoRoot, tree, head) : head

  return {
    repoRoot,
    subdir,
    head,
    branch,
    snapshot,
    dirty,
    ...(await identifyRepo(repoRoot, origin || null)),
  }
}
