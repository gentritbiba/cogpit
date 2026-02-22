import { execSync, execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import {
  dirs,
  isWithinDir,
  readdir,
  readFile,
  open,
  join,
} from "../helpers"
import type { UseFn, WorktreeInfo, FileChange } from "../helpers"

interface WorktreeRaw {
  path: string
  head: string
  branch: string
}

function isValidWorktreeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length <= 40
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

async function resolveProjectPath(projectDir: string, dirName: string): Promise<string> {
  try {
    const files = await readdir(projectDir)
    for (const f of files.filter((f: string) => f.endsWith(".jsonl"))) {
      try {
        const fh = await open(join(projectDir, f), "r")
        try {
          const buf = Buffer.alloc(4096)
          const { bytesRead } = await fh.read(buf, 0, 4096, 0)
          const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0]
          if (firstLine) {
            const parsed = JSON.parse(firstLine)
            if (parsed.cwd) {
              return parsed.cwd
            }
          }
        } finally {
          await fh.close()
        }
      } catch {
        continue
      }
    }
  } catch {
    // projectDir might not exist yet
  }
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

function getMainWorktreeRoot(projectPath: string): string | null {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: projectPath,
      encoding: "utf-8",
    }).trim()
    // --git-common-dir returns the path to the shared .git directory.
    // From main repo: ".git" (relative). From worktree: absolute or relative path to main .git.
    // Resolving it and taking dirname gives the main repo root.
    return dirname(resolve(projectPath, commonDir))
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

      const projectPath = await resolveProjectPath(projectDir, dirName)
      const gitRoot = getMainWorktreeRoot(projectPath)

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

      if (!isValidWorktreeName(worktreeName)) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid worktree name" }))
        return
      }

      const projectPath = await resolveProjectPath(projectDir, dirName)
      const gitRoot = getMainWorktreeRoot(projectPath)

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
        execFileSync("git", ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], {
          cwd: gitRoot,
          encoding: "utf-8",
        })

        try {
          const deleteFlag = force ? "-D" : "-d"
          execFileSync("git", ["branch", deleteFlag, branchName], {
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

      const projectPath = await resolveProjectPath(projectDir, dirName)
      const gitRoot = getMainWorktreeRoot(projectPath)

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

      const parsed: { worktreeName?: string; title?: string; body?: string } = body ? JSON.parse(body) : {}
      const { worktreeName, title, body: prBody } = parsed
      if (!worktreeName) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "worktreeName is required" }))
        return
      }

      if (!isValidWorktreeName(worktreeName)) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid worktree name" }))
        return
      }

      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        // Push branch
        execFileSync("git", ["push", "-u", "origin", branchName], {
          cwd: worktreePath,
          encoding: "utf-8",
        })

        // Create PR
        const prTitle = title || worktreeName.replace(/-/g, " ")
        const ghArgs = ["pr", "create", "--title", prTitle, "--head", branchName]
        if (prBody) ghArgs.push("--body", prBody)
        const prUrl = execFileSync("gh", ghArgs, {
          cwd: worktreePath,
          encoding: "utf-8",
        }).toString().trim()

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

      const projectPath = await resolveProjectPath(projectDir, dirName)
      const gitRoot = getMainWorktreeRoot(projectPath)

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
            const status = execFileSync("git", ["status", "--porcelain"], {
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
            execFileSync("git", ["worktree", "remove", wt.path], { cwd: gitRoot, encoding: "utf-8" })
            try {
              execFileSync("git", ["branch", "-d", wt.branch], { cwd: gitRoot, encoding: "utf-8" })
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
