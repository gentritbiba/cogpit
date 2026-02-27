import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import {
  dirs,
  isWithinDir,
  join,
} from "../../helpers"
import type { UseFn } from "../../helpers"
import {
  isValidWorktreeName,
  parseWorktreeList,
  resolveProjectPath,
  getMainWorktreeRoot,
} from "./worktreeUtils"
import { handleWorktreeList } from "./worktreeListRoute"

export { isValidWorktreeName, parseWorktreeList, resolveProjectPath, getMainWorktreeRoot, getDefaultBranch } from "./worktreeUtils"
export { handleWorktreeList } from "./worktreeListRoute"

export function registerWorktreeRoutes(use: UseFn) {
  use("/api/worktrees", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)

    // GET /api/worktrees/:dirName — list worktrees for a project
    if (req.method === "GET" && pathParts.length === 1) {
      const dirName = decodeURIComponent(pathParts[0])
      await handleWorktreeList(dirName, res)
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

      let force = false
      try {
        if (body) ({ force = false } = JSON.parse(body))
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
        return
      }
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

      let parsed: { worktreeName?: string; title?: string; body?: string } = {}
      try {
        if (body) parsed = JSON.parse(body)
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
        return
      }
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

      let confirm: boolean | undefined
      let names: string[] | undefined
      let maxAgeDays = 7
      try {
        if (body) ({ confirm, names, maxAgeDays = 7 } = JSON.parse(body))
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
        return
      }

      try {
        const rawOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
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
      } catch (err) {
        console.error("[worktrees] cleanup failed:", err instanceof Error ? err.message : err)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ stale: [] }))
      }
      return
    }

    next()
  })
}
