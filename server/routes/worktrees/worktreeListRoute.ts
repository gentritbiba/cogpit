import { stat } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import {
  dirs,
  isWithinDir,
  readdir,
  join,
} from "../../helpers"
import type { FileChange, WorktreeInfo } from "../../../shared/contracts/worktrees"
import {
  parseWorktreeList,
  resolveProjectPath,
  getMainWorktreeRoot,
  getDefaultBranch,
  readFirstJsonLine,
} from "./worktreeUtils"
import type { WorktreeRaw } from "./worktreeUtils"
import {
  mapWithConcurrency,
  runWorktreeCommand,
  SESSION_HEADER_CONCURRENCY,
  WORKTREE_SCAN_CONCURRENCY,
} from "./worktreeIo"

async function loadSessionBranches(projectDir: string): Promise<Map<string, string[]>> {
  const sessionBranches = new Map<string, string[]>()

  try {
    const files = await readdir(projectDir)
    const sessionFiles = files.filter((file: string) => file.endsWith(".jsonl"))
    const headers = await mapWithConcurrency(
      sessionFiles,
      SESSION_HEADER_CONCURRENCY,
      async (file) => {
        try {
          return {
            file,
            header: await readFirstJsonLine(join(projectDir, file)),
          }
        } catch {
          return { file, header: null }
        }
      },
    )

    for (const { file, header } of headers) {
      if (typeof header?.gitBranch !== "string" || !header.gitBranch) continue
      const sessionId = file.slice(0, -".jsonl".length)
      const existing = sessionBranches.get(header.gitBranch) ?? []
      existing.push(sessionId)
      sessionBranches.set(header.gitBranch, existing)
    }
  } catch {
    // Project directory may not exist yet.
  }

  return sessionBranches
}

function mergeNumstat(changedFiles: FileChange[], seen: Set<string>, output: string): void {
  for (const line of output.trim().split("\n")) {
    if (!line) continue
    const [additions, deletions, filePath] = line.split("\t")
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    changedFiles.push({
      path: filePath,
      status: "M",
      additions: Number.parseInt(additions, 10) || 0,
      deletions: Number.parseInt(deletions, 10) || 0,
    })
  }
}

async function loadChangedFiles(worktreePath: string, defaultBranch: string): Promise<FileChange[]> {
  const changedFiles: FileChange[] = []

  try {
    const committedOutput = await runWorktreeCommand(
      "git",
      ["diff", "--numstat", `${defaultBranch}..HEAD`],
      { cwd: worktreePath },
    )
    const uncommittedOutput = await runWorktreeCommand(
      "git",
      ["diff", "--numstat"],
      { cwd: worktreePath },
    )

    const seen = new Set<string>()
    mergeNumstat(changedFiles, seen, committedOutput)
    mergeNumstat(changedFiles, seen, uncommittedOutput)

    try {
      const added = new Set(
        (await runWorktreeCommand(
          "git",
          ["diff", "--diff-filter=A", "--name-only", `${defaultBranch}..HEAD`],
          { cwd: worktreePath },
        )).trim().split("\n").filter(Boolean),
      )
      const deleted = new Set(
        (await runWorktreeCommand(
          "git",
          ["diff", "--diff-filter=D", "--name-only", `${defaultBranch}..HEAD`],
          { cwd: worktreePath },
        )).trim().split("\n").filter(Boolean),
      )
      for (const file of changedFiles) {
        if (added.has(file.path)) file.status = "A"
        if (deleted.has(file.path)) file.status = "D"
      }
    } catch {
      // Preserve numstat data if status classification fails.
    }
  } catch {
    // A partially unavailable worktree has no diff summary.
  }

  return changedFiles
}

async function buildWorktreeInfo(
  worktree: WorktreeRaw,
  defaultBranch: string,
  sessionBranches: ReadonlyMap<string, string[]>,
): Promise<WorktreeInfo> {
  const name = worktree.branch.replace("worktree-", "")

  let isDirty = false
  try {
    const status = await runWorktreeCommand("git", ["status", "--porcelain"], {
      cwd: worktree.path,
    })
    isDirty = status.trim().length > 0
  } catch {
    // Keep the best-effort default.
  }

  let commitsAhead = 0
  try {
    const count = await runWorktreeCommand(
      "git",
      ["rev-list", "--count", `${defaultBranch}..HEAD`],
      { cwd: worktree.path },
    )
    commitsAhead = Number.parseInt(count.trim(), 10) || 0
  } catch {
    // Keep the best-effort default.
  }

  let headMessage = ""
  try {
    headMessage = (await runWorktreeCommand("git", ["log", "-1", "--format=%s"], {
      cwd: worktree.path,
    })).trim()
  } catch {
    // Keep the best-effort default.
  }

  let createdAt = ""
  try {
    createdAt = (await stat(worktree.path)).birthtime.toISOString()
  } catch {
    // Keep the best-effort default.
  }

  return {
    name,
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head?.slice(0, 7) || "",
    headMessage,
    isDirty,
    commitsAhead,
    linkedSessions: sessionBranches.get(worktree.branch) || [],
    createdAt,
    changedFiles: await loadChangedFiles(worktree.path, defaultBranch),
  }
}

export async function handleWorktreeList(
  dirName: string,
  res: ServerResponse,
): Promise<void> {
  const projectDir = join(dirs.PROJECTS_DIR, dirName)

  if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
    res.statusCode = 403
    res.end(JSON.stringify({ error: "Access denied" }))
    return
  }

  const projectPath = await resolveProjectPath(projectDir, dirName)
  const gitRoot = await getMainWorktreeRoot(projectPath)

  if (!gitRoot) {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify([]))
    return
  }

  try {
    const rawOutput = await runWorktreeCommand("git", ["worktree", "list", "--porcelain"], {
      cwd: gitRoot,
    })

    const rawWorktrees = parseWorktreeList(rawOutput)
    const [defaultBranch, sessionBranches] = await Promise.all([
      getDefaultBranch(gitRoot),
      loadSessionBranches(projectDir),
    ])
    const worktrees = await mapWithConcurrency(
      rawWorktrees,
      WORKTREE_SCAN_CONCURRENCY,
      (worktree) => buildWorktreeInfo(worktree, defaultBranch, sessionBranches),
    )

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(worktrees))
  } catch (err) {
    console.error("[worktrees] failed to list worktrees:", err instanceof Error ? err.message : err)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify([]))
  }
}
