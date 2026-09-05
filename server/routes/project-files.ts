import { execFile as execFileCallback } from "node:child_process"
import { readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { sendJson, type UseFn } from "../http"
import { rankProjectFiles } from "./project-files-ranking"

const MAX_FILES = 20_000
const CACHE_TTL_MS = 30_000
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])

const fileCache = new Map<string, { expiresAt: number; files: string[] }>()
const execFile = promisify(execFileCallback)

async function listGitProjectFiles(root: string): Promise<string[] | null> {
  try {
    const result = await execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    )
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .slice(0, MAX_FILES)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return null
  }
}

export async function listProjectFiles(
  root: string,
  { skipCache = false }: { skipCache?: boolean } = {},
): Promise<string[]> {
  const cached = fileCache.get(root)
  if (!skipCache && cached && cached.expiresAt > Date.now()) return cached.files

  const gitFiles = await listGitProjectFiles(root)
  if (gitFiles) {
    fileCache.set(root, { expiresAt: Date.now() + CACHE_TTL_MS, files: gitFiles })
    return gitFiles
  }

  const files: string[] = []
  const pending = [root]
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      files.push(relative(root, absolutePath).split(sep).join("/"))
      if (files.length >= MAX_FILES) break
    }
  }
  files.sort((a, b) => a.localeCompare(b))
  fileCache.set(root, { expiresAt: Date.now() + CACHE_TTL_MS, files })
  return files
}

export interface ProjectTreeEntry {
  name: string
  type: "file" | "directory"
}

/**
 * Direct children of `directory` (project-relative, "" for the root) derived
 * from the flat listing, so the tree honours the same ignore rules as search.
 * Directories sort before files, each group alphabetically. A directory whose
 * only child is another directory is reported as one entry named with the
 * whole chain (`src/components/ui`), the way compact folder views draw it.
 */
export function listDirectoryEntries(files: string[], directory: string): ProjectTreeEntry[] {
  const prefix = directory ? `${directory.replace(/\/+$/, "")}/` : ""
  const children = directChildren(files, prefix)
  return [
    ...children.directories.map((name) => ({ name: compactChain(files, prefix, name), type: "directory" as const })),
    ...children.files.map((name) => ({ name, type: "file" as const })),
  ]
}

/** Names one level below `prefix`, each group sorted alphabetically. */
function directChildren(files: string[], prefix: string): { directories: string[]; files: string[] } {
  const directories = new Set<string>()
  const plainFiles = new Set<string>()
  for (const file of files) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash === -1) plainFiles.add(rest)
    else directories.add(rest.slice(0, slash))
  }
  const byName = (a: string, b: string) => a.localeCompare(b)
  return { directories: [...directories].sort(byName), files: [...plainFiles].sort(byName) }
}

function compactChain(files: string[], prefix: string, name: string): string {
  let chain = name
  for (;;) {
    const children = directChildren(files, `${prefix}${chain}/`)
    if (children.files.length > 0 || children.directories.length !== 1) return chain
    chain = `${chain}/${children.directories[0]}`
  }
}

async function resolveProjectRoot(cwd: string): Promise<{ root: string } | { error: string; status: number }> {
  if (!isAbsolute(cwd)) return { error: "cwd must be an absolute path", status: 400 }
  try {
    const root = resolve(cwd)
    const info = await stat(root)
    if (!info.isDirectory()) return { error: "cwd must be a directory", status: 400 }
    // Canonicalize so a symlinked project root keys the cache — and relativizes
    // paths — the same way /api/git-status and /api/project-file do.
    return { root: await realpath(root) }
  } catch {
    return { error: "Project directory not found", status: 404 }
  }
}

export function registerProjectFileRoutes(use: UseFn) {
  use("/api/project-files/tree", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    const directory = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "")
    if (directory.split("/").some((segment) => segment === "..")) {
      return sendJson(res, 400, { error: "dir must stay inside the project" })
    }
    const resolved = await resolveProjectRoot(url.searchParams.get("cwd") ?? "")
    if ("error" in resolved) return sendJson(res, resolved.status, { error: resolved.error })
    const files = await listProjectFiles(resolved.root, { skipCache: url.searchParams.get("refresh") === "1" })
    return sendJson(res, 200, {
      entries: listDirectoryEntries(files, directory),
      scanLimited: files.length >= MAX_FILES,
    })
  })

  use("/api/project-files", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    const query = url.searchParams.get("q") ?? ""
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100)
    const skipCache = url.searchParams.get("refresh") === "1"

    const resolved = await resolveProjectRoot(url.searchParams.get("cwd") ?? "")
    if ("error" in resolved) return sendJson(res, resolved.status, { error: resolved.error })
    const files = await listProjectFiles(resolved.root, { skipCache })
    const ranked = rankProjectFiles(files, query, limit)
    return sendJson(res, 200, {
      files: ranked.files,
      totalMatches: ranked.totalMatches,
      scanLimited: files.length >= MAX_FILES,
    })
  })
}
