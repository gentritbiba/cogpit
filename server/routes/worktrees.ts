import { execSync } from "node:child_process"
import { statSync } from "node:fs"
import {
  dirs,
  isWithinDir,
  readdir,
  readFile,
  join,
} from "../helpers"
import type { UseFn, WorktreeInfo } from "../helpers"

interface WorktreeRaw {
  path: string
  head: string
  branch: string
}

function parseWorktreeList(output: string): WorktreeRaw[] {
  const worktrees: WorktreeRaw[] = []
  let current: Partial<WorktreeRaw> = {}

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) }
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    } else if (line === "" && current.path) {
      if (current.branch?.startsWith("worktree-")) {
        worktrees.push(current as WorktreeRaw)
      }
      current = {}
    }
  }
  return worktrees
}

function resolveProjectPath(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

function getGitRoot(projectPath: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: projectPath,
      encoding: "utf-8",
    }).trim()
  } catch {
    return null
  }
}

function getDefaultBranch(gitRoot: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: gitRoot,
      encoding: "utf-8",
    }).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    return "main"
  }
}

export function registerWorktreeRoutes(use: UseFn) {
  use("/api/worktrees", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)

    // GET /api/worktrees/:dirName — list worktrees for a project
    if (req.method === "GET" && pathParts.length === 1) {
      const dirName = decodeURIComponent(pathParts[0])
      const projectDir = join(dirs.PROJECTS_DIR, dirName)

      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
        return
      }

      try {
        const rawOutput = execSync("git worktree list --porcelain", {
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
            const status = execSync("git status --porcelain", {
              cwd: wt.path,
              encoding: "utf-8",
            })
            isDirty = status.trim().length > 0
          } catch { /* */ }

          let commitsAhead = 0
          try {
            const count = execSync(
              `git rev-list --count ${defaultBranch}..HEAD`,
              { cwd: wt.path, encoding: "utf-8" }
            )
            commitsAhead = parseInt(count.trim(), 10) || 0
          } catch { /* */ }

          let headMessage = ""
          try {
            headMessage = execSync("git log -1 --format=%s", {
              cwd: wt.path,
              encoding: "utf-8",
            }).trim()
          } catch { /* */ }

          let createdAt = ""
          try {
            const stat = statSync(wt.path)
            createdAt = stat.birthtime.toISOString()
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
          }
        })

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(worktrees))
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
      }
      return
    }

    // DELETE /api/worktrees/:dirName/:worktreeName
    if (req.method === "DELETE" && pathParts.length === 2) {
      const dirName = decodeURIComponent(pathParts[0])
      const worktreeName = decodeURIComponent(pathParts[1])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { force } = body ? JSON.parse(body) : { force: false }
      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        const removeArgs = force ? "--force" : ""
        execSync(`git worktree remove ${removeArgs} "${worktreePath}"`, {
          cwd: gitRoot,
          encoding: "utf-8",
        })

        try {
          const deleteFlag = force ? "-D" : "-d"
          execSync(`git branch ${deleteFlag} "${branchName}"`, {
            cwd: gitRoot,
            encoding: "utf-8",
          })
        } catch { /* branch may already be gone */ }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({
          error: `Failed to remove worktree: ${err instanceof Error ? err.message : "unknown"}`,
        }))
      }
      return
    }

    // POST /api/worktrees/:dirName/create-pr
    if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "create-pr") {
      const dirName = decodeURIComponent(pathParts[0])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { worktreeName, title, body: prBody } = JSON.parse(body)
      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        // Push branch
        execSync(`git push -u origin "${branchName}"`, {
          cwd: worktreePath,
          encoding: "utf-8",
        })

        // Create PR
        const prTitle = title || worktreeName.replace(/-/g, " ")
        const prBodyArg = prBody ? `--body "${prBody.replace(/"/g, '\\"')}"` : ""
        const prUrl = execSync(
          `gh pr create --title "${prTitle}" ${prBodyArg} --head "${branchName}"`,
          { cwd: worktreePath, encoding: "utf-8" }
        ).trim()

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ url: prUrl }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({
          error: `Failed to create PR: ${err instanceof Error ? err.message : "unknown"}`,
        }))
      }
      return
    }

    // POST /api/worktrees/:dirName/cleanup
    if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "cleanup") {
      const dirName = decodeURIComponent(pathParts[0])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { confirm, names, maxAgeDays = 7 } = body ? JSON.parse(body) : {}

      try {
        const rawOutput = execSync("git worktree list --porcelain", {
          cwd: gitRoot,
          encoding: "utf-8",
        })
        const rawWorktrees = parseWorktreeList(rawOutput)
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

        const stale = rawWorktrees.filter((wt) => {
          try {
            const status = execSync("git status --porcelain", {
              cwd: wt.path,
              encoding: "utf-8",
            })
            if (status.trim().length > 0) return false
            const stat = statSync(wt.path)
            return stat.birthtime.getTime() < cutoff
          } catch {
            return false
          }
        })

        if (!confirm) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            stale: stale.map((wt) => ({
              name: wt.branch.replace("worktree-", ""),
              path: wt.path,
              branch: wt.branch,
            })),
          }))
          return
        }

        // Perform cleanup on confirmed names
        const namesToRemove = new Set(names || stale.map((wt) => wt.branch.replace("worktree-", "")))
        const removed: string[] = []
        const errors: string[] = []

        for (const wt of stale) {
          const name = wt.branch.replace("worktree-", "")
          if (!namesToRemove.has(name)) continue
          try {
            execSync(`git worktree remove "${wt.path}"`, { cwd: gitRoot, encoding: "utf-8" })
            try {
              execSync(`git branch -d "${wt.branch}"`, { cwd: gitRoot, encoding: "utf-8" })
            } catch { /* */ }
            removed.push(name)
          } catch (err) {
            errors.push(`${name}: ${err instanceof Error ? err.message : "unknown"}`)
          }
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ removed, errors }))
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ stale: [] }))
      }
      return
    }

    next()
  })
}
