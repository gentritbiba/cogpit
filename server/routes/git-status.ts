import { execFile as execFileCallback } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"

const execFile = promisify(execFileCallback)

export interface GitStatusFile {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface ParsedGitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  files: GitStatusFile[]
}

function parseBranchHeader(header: string): Omit<ParsedGitStatus, "files"> {
  const value = header.replace(/^##\s*/, "")
  if (value === "HEAD (no branch)") {
    return { branch: null, upstream: null, ahead: 0, behind: 0, detached: true }
  }

  const normalized = value.replace(/^(?:No commits yet on|Initial commit on)\s+/, "")
  const trackingIndex = normalized.indexOf("...")
  const detailIndex = normalized.indexOf(" [")
  const branchEnd = trackingIndex >= 0 ? trackingIndex : detailIndex >= 0 ? detailIndex : normalized.length
  const branch = normalized.slice(0, branchEnd).trim() || null
  const upstreamStart = trackingIndex >= 0 ? trackingIndex + 3 : -1
  const upstreamEnd = detailIndex >= 0 ? detailIndex : normalized.length
  const upstream = upstreamStart >= 0 ? normalized.slice(upstreamStart, upstreamEnd).trim() || null : null
  const detail = detailIndex >= 0 ? normalized.slice(detailIndex) : ""
  const ahead = Number(detail.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(detail.match(/behind (\d+)/)?.[1] ?? 0)
  return { branch, upstream, ahead, behind, detached: false }
}

export function parseGitStatus(output: string): ParsedGitStatus {
  const records = output.split("\0")
  const header = records.shift() ?? ""
  const branch = parseBranchHeader(header)
  const files: GitStatusFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 3) continue
    const indexStatus = record[0]
    const workTreeStatus = record[1]
    const path = record.slice(3)
    const renamedOrCopied = /[RC]/.test(`${indexStatus}${workTreeStatus}`)
    const originalPath = renamedOrCopied ? records[index += 1] || undefined : undefined
    files.push({ path, originalPath, indexStatus, workTreeStatus })
  }

  return { ...branch, files }
}

/**
 * Git prints status paths relative to the repository root, but the panel and
 * the project-file routes operate relative to the requested cwd. Strip the
 * root-to-cwd prefix and drop entries outside the cwd so both sides agree.
 */
export function relativizeToCwd(files: GitStatusFile[], root: string, projectPath: string): GitStatusFile[] {
  const prefix = relative(root, projectPath).split(sep).filter(Boolean).join("/")
  if (!prefix) return files
  const strip = (path: string) => (path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null)
  return files.flatMap((file) => {
    const path = strip(file.path)
    if (path === null) return []
    const originalPath = file.originalPath ? strip(file.originalPath) ?? undefined : undefined
    return [{ ...file, path, originalPath }]
  })
}

async function runGit(cwd: string, args: string[]) {
  return execFile("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  })
}

export function registerGitStatusRoutes(use: UseFn) {
  use("/api/git-status", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    const cwd = url.searchParams.get("cwd") ?? ""
    if (!isAbsolute(cwd)) return sendJson(res, 400, { error: "cwd must be an absolute path" })

    let projectPath: string
    try {
      projectPath = await realpath(resolve(cwd))
      if (!(await stat(projectPath)).isDirectory()) {
        return sendJson(res, 400, { error: "cwd must be a directory" })
      }
    } catch {
      return sendJson(res, 404, { error: "Project directory not found" })
    }

    try {
      const rootResult = await runGit(projectPath, ["rev-parse", "--show-toplevel"])
      const root = rootResult.stdout.trim()
      const statusResult = await runGit(root, [
        "-c",
        "color.status=false",
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
      ])
      const parsed = parseGitStatus(statusResult.stdout)
      return sendJson(res, 200, {
        isRepository: true,
        root,
        ...parsed,
        files: relativizeToCwd(parsed.files, root, projectPath),
      })
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException & { stderr?: string }
      if (candidate.code === "ENOENT") {
        return sendJson(res, 503, { error: "Git is not installed or not available in PATH" })
      }
      if (/not a git repository/i.test(candidate.stderr ?? candidate.message)) {
        return sendJson(res, 200, { isRepository: false, files: [] })
      }
      return sendJson(res, 500, { error: "Unable to read git status" })
    }
  })
}
