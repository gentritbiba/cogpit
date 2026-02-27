import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import type { ServerResponse } from "node:http"
import {
  dirs,
  isWithinDir,
  readdir,
  readFile,
  join,
} from "../../helpers"
import type { WorktreeInfo, FileChange } from "../../helpers"
import {
  parseWorktreeList,
  resolveProjectPath,
  getMainWorktreeRoot,
  getDefaultBranch,
} from "./worktreeUtils"

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
  const gitRoot = getMainWorktreeRoot(projectPath)

  if (!gitRoot) {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify([]))
    return
  }

  try {
    const rawOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: gitRoot,
      encoding: "utf-8",
    })

    const rawWorktrees = parseWorktreeList(rawOutput)
    const defaultBranch = getDefaultBranch(gitRoot)

    // Load session metadata for linking
    const sessionBranches = new Map<string, string[]>()
    try {
      const files = await readdir(projectDir)
      for (const f of files.filter((f: string) => f.endsWith(".jsonl"))) {
        try {
          const content = await readFile(join(projectDir, f), "utf-8")
          const firstLine = content.split("\n")[0]
          if (firstLine) {
            const parsed = JSON.parse(firstLine)
            if (parsed.gitBranch) {
              const sessionId = f.replace(".jsonl", "")
              const existing = sessionBranches.get(parsed.gitBranch) || []
              existing.push(sessionId)
              sessionBranches.set(parsed.gitBranch, existing)
            }
          }
        } catch { continue }
      }
    } catch { /* project dir may not exist */ }

    const worktrees: WorktreeInfo[] = rawWorktrees.map((wt) => {
      const name = wt.branch.replace("worktree-", "")

      let isDirty = false
      try {
        const status = execFileSync("git", ["status", "--porcelain"], {
          cwd: wt.path,
          encoding: "utf-8",
        })
        isDirty = status.trim().length > 0
      } catch { /* */ }

      let commitsAhead = 0
      try {
        const count = execFileSync(
          "git",
          ["rev-list", "--count", `${defaultBranch}..HEAD`],
          { cwd: wt.path, encoding: "utf-8" }
        )
        commitsAhead = parseInt(count.trim(), 10) || 0
      } catch { /* */ }

      let headMessage = ""
      try {
        headMessage = execFileSync("git", ["log", "-1", "--format=%s"], {
          cwd: wt.path,
          encoding: "utf-8",
        }).trim()
      } catch { /* */ }

      let createdAt = ""
      try {
        const stat = statSync(wt.path)
        createdAt = stat.birthtime.toISOString()
      } catch { /* */ }

      const changedFiles: FileChange[] = []
      try {
        // Get diff stats against default branch
        const diffOutput = execFileSync(
          "git",
          ["diff", "--numstat", `${defaultBranch}..HEAD`],
          { cwd: wt.path, encoding: "utf-8" }
        )
        // Also get uncommitted changes
        const uncommittedOutput = execFileSync(
          "git",
          ["diff", "--numstat"],
          { cwd: wt.path, encoding: "utf-8" }
        )

        const seen = new Set<string>()
        for (const output of [diffOutput, uncommittedOutput]) {
          for (const line of output.trim().split("\n")) {
            if (!line) continue
            const [add, del, filePath] = line.split("\t")
            if (!filePath || seen.has(filePath)) continue
            seen.add(filePath)
            changedFiles.push({
              path: filePath,
              status: "M",
              additions: parseInt(add, 10) || 0,
              deletions: parseInt(del, 10) || 0,
            })
          }
        }

        // Detect added/deleted files via --diff-filter
        try {
          const added = execFileSync(
            "git",
            ["diff", "--diff-filter=A", "--name-only", `${defaultBranch}..HEAD`],
            { cwd: wt.path, encoding: "utf-8" }
          ).trim().split("\n").filter(Boolean)
          const deleted = execFileSync(
            "git",
            ["diff", "--diff-filter=D", "--name-only", `${defaultBranch}..HEAD`],
            { cwd: wt.path, encoding: "utf-8" }
          ).trim().split("\n").filter(Boolean)
          for (const f of changedFiles) {
            if (added.includes(f.path)) f.status = "A"
            if (deleted.includes(f.path)) f.status = "D"
          }
        } catch { /* */ }
      } catch { /* */ }

      return {
        name,
        path: wt.path,
        branch: wt.branch,
        head: wt.head?.slice(0, 7) || "",
        headMessage,
        isDirty,
        commitsAhead,
        linkedSessions: sessionBranches.get(wt.branch) || [],
        createdAt,
        changedFiles,
      }
    })

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(worktrees))
  } catch (err) {
    console.error("[worktrees] failed to list worktrees:", err instanceof Error ? err.message : err)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify([]))
  }
}
