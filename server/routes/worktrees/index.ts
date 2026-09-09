import { stat } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import {
  dirs,
  isWithinDir,
  join,
} from "../../helpers"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../../http"
import {
  isValidWorktreeName,
  parseWorktreeList,
  resolveProjectPath,
  getMainWorktreeRoot,
} from "./worktreeUtils"
import type { WorktreeRaw } from "./worktreeUtils"
import { handleWorktreeList } from "./worktreeListRoute"
import {
  mapWithConcurrency,
  runWorktreeCommand,
  WORKTREE_NETWORK_TIMEOUT_MS,
  WORKTREE_SCAN_CONCURRENCY,
} from "./worktreeIo"

function requireProjectDir(dirName: string, res: ServerResponse): string | null {
  const projectDir = join(dirs.PROJECTS_DIR, dirName)
  if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
    res.statusCode = 403
    res.end(JSON.stringify({ error: "Access denied" }))
    return null
  }

  return projectDir
}

async function requireGitRoot(
  projectDir: string,
  dirName: string,
  res: ServerResponse,
): Promise<string | null> {
  const projectPath = await resolveProjectPath(projectDir, dirName)
  const gitRoot = await getMainWorktreeRoot(projectPath)
  if (!gitRoot) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: "Not a git repository" }))
    return null
  }

  return gitRoot
}

async function findStaleWorktrees(
  worktrees: readonly WorktreeRaw[],
  cutoff: number,
): Promise<WorktreeRaw[]> {
  const candidates = await mapWithConcurrency(
    worktrees,
    WORKTREE_SCAN_CONCURRENCY,
    async (worktree) => {
      try {
        const status = await runWorktreeCommand("git", ["status", "--porcelain"], {
          cwd: worktree.path,
        })
        if (status.trim()) return null
        const worktreeStat = await stat(worktree.path)
        return worktreeStat.birthtime.getTime() < cutoff ? worktree : null
      } catch {
        return null
      }
    },
  )

  return candidates.filter((worktree): worktree is WorktreeRaw => worktree !== null)
}

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
      const projectDir = requireProjectDir(dirName, res)
      if (!projectDir) return

      if (!isValidWorktreeName(worktreeName)) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid worktree name" }))
        return
      }

      const gitRoot = await requireGitRoot(projectDir, dirName, res)
      if (!gitRoot) return

      let force = false
      try {
        ({ force = false } = await readJsonBody<{ force?: boolean }>(req, { allowEmpty: true }))
      } catch (error) {
        sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, {
          error: error instanceof HttpBodyError ? error.message : "Invalid request body",
        })
        return
      }
      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        await runWorktreeCommand("git", ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], {
          cwd: gitRoot,
        })

        try {
          const deleteFlag = force ? "-D" : "-d"
          await runWorktreeCommand("git", ["branch", deleteFlag, branchName], {
            cwd: gitRoot,
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
      const projectDir = requireProjectDir(dirName, res)
      if (!projectDir) return

      const gitRoot = await requireGitRoot(projectDir, dirName, res)
      if (!gitRoot) return

      let parsed: { worktreeName?: string; title?: string; body?: string } = {}
      try {
        parsed = await readJsonBody<typeof parsed>(req, { allowEmpty: true })
      } catch (error) {
        sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, {
          error: error instanceof HttpBodyError ? error.message : "Invalid request body",
        })
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
        await runWorktreeCommand("git", ["push", "-u", "origin", branchName], {
          cwd: worktreePath,
          timeoutMs: WORKTREE_NETWORK_TIMEOUT_MS,
        })

        // Create PR
        const prTitle = title || worktreeName.replace(/-/g, " ")
        const ghArgs = [
          "pr",
          "create",
          "--title",
          prTitle,
          "--head",
          branchName,
          "--body",
          prBody ?? "",
        ]
        const prUrl = (await runWorktreeCommand("gh", ghArgs, {
          cwd: worktreePath,
          timeoutMs: WORKTREE_NETWORK_TIMEOUT_MS,
        })).trim()

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
      const projectDir = requireProjectDir(dirName, res)
      if (!projectDir) return

      const gitRoot = await requireGitRoot(projectDir, dirName, res)
      if (!gitRoot) return

      let confirm: boolean | undefined
      let names: string[] | undefined
      let maxAgeDays = 7
      try {
        ({ confirm, names, maxAgeDays = 7 } = await readJsonBody<{
          confirm?: boolean
          names?: string[]
          maxAgeDays?: number
        }>(req, { allowEmpty: true }))
      } catch (error) {
        sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, {
          error: error instanceof HttpBodyError ? error.message : "Invalid request body",
        })
        return
      }

      try {
        const rawOutput = await runWorktreeCommand("git", ["worktree", "list", "--porcelain"], {
          cwd: gitRoot,
        })
        const rawWorktrees = parseWorktreeList(rawOutput)
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
        const stale = await findStaleWorktrees(rawWorktrees, cutoff)

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
            await runWorktreeCommand("git", ["worktree", "remove", wt.path], { cwd: gitRoot })
            try {
              await runWorktreeCommand("git", ["branch", "-d", wt.branch], { cwd: gitRoot })
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
