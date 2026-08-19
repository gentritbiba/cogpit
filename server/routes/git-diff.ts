import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { isWithinDir } from "../helpers"
import { sendJson, type UseFn } from "../http"
import { resolveGitProject, runGit } from "../lib/gitProject"

const MAX_DIFF_BYTES = 2 * 1024 * 1024
/** Git's own heuristic: a NUL byte in the first 8000 bytes means "binary". */
const BINARY_SNIFF_BYTES = 8000

export interface GitDiffSide {
  /** File contents, or null when the file does not exist on this side. */
  content: string | null
  binary: boolean
  tooLarge: boolean
}

function readSide(buffer: Buffer | null): GitDiffSide {
  if (!buffer) return { content: null, binary: false, tooLarge: false }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { content: null, binary: true, tooLarge: false }
  }
  if (buffer.byteLength > MAX_DIFF_BYTES) return { content: null, binary: false, tooLarge: true }
  return { content: buffer.toString("utf-8"), binary: false, tooLarge: false }
}

async function readCommittedBlob(root: string, repoPath: string): Promise<Buffer | null> {
  try {
    const result = await runGit(root, ["show", `HEAD:${repoPath}`])
    return Buffer.from(result.stdout, "utf-8")
  } catch {
    // Absent from HEAD: a new file, or a repository without commits yet.
    return null
  }
}

async function readWorkingFile(root: string, absolutePath: string): Promise<Buffer | null> {
  try {
    // Resolve symlinks before reading so a link inside the repo cannot serve a
    // file outside it.
    const real = await realpath(absolutePath)
    if (!isWithinDir(root, real)) return null
    return await readFile(real)
  } catch {
    return null
  }
}

/** Repository-relative POSIX path, or null when it escapes the repository. */
function toRepoPath(root: string, projectPath: string, filePath: string): string | null {
  const candidate = resolve(projectPath, filePath)
  if (!isWithinDir(root, candidate)) return null
  return relative(root, candidate).split(sep).join("/")
}

export function registerGitDiffRoutes(use: UseFn) {
  use("/api/git-diff", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    const cwd = url.searchParams.get("cwd") ?? ""
    const filePath = url.searchParams.get("path") ?? ""
    // Renames diff against the pre-rename blob, which lives at a different path.
    const originalPath = url.searchParams.get("originalPath") || filePath

    if (!filePath || isAbsolute(filePath) || filePath.includes("\0")) {
      return sendJson(res, 400, { error: "path must be a relative project file" })
    }

    const project = await resolveGitProject(cwd)
    if (!project.ok) return sendJson(res, project.status, { error: project.error })
    const { projectPath, root } = project
    if (!root) return sendJson(res, 400, { error: "Not a git repository" })

    const headRepoPath = toRepoPath(root, projectPath, originalPath)
    const absolutePath = resolve(projectPath, filePath)
    if (headRepoPath === null || !isWithinDir(root, absolutePath)) {
      return sendJson(res, 403, { error: "File is outside the project" })
    }

    try {
      const [committed, working] = await Promise.all([
        readCommittedBlob(root, headRepoPath).then(readSide),
        readWorkingFile(root, absolutePath).then(readSide),
      ])
      return sendJson(res, 200, {
        path: filePath,
        original: committed.content,
        current: working.content,
        binary: committed.binary || working.binary,
        tooLarge: committed.tooLarge || working.tooLarge,
      })
    } catch {
      return sendJson(res, 500, { error: "Unable to read file diff" })
    }
  })
}
