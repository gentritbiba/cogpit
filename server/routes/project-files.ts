import { execFile as execFileCallback } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
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

export async function listProjectFiles(root: string): Promise<string[]> {
  const cached = fileCache.get(root)
  if (cached && cached.expiresAt > Date.now()) return cached.files

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

export function registerProjectFileRoutes(use: UseFn) {
  use("/api/project-files", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    const cwd = url.searchParams.get("cwd") ?? ""
    const query = url.searchParams.get("q") ?? ""
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100)

    if (!isAbsolute(cwd)) return sendJson(res, 400, { error: "cwd must be an absolute path" })
    const root = resolve(cwd)
    try {
      const info = await stat(root)
      if (!info.isDirectory()) return sendJson(res, 400, { error: "cwd must be a directory" })
      const files = await listProjectFiles(root)
      return sendJson(res, 200, {
        files: rankProjectFiles(files, query, limit),
        truncated: files.length >= MAX_FILES,
      })
    } catch {
      return sendJson(res, 404, { error: "Project directory not found" })
    }
  })
}
