import { stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { resolveProjectCwd } from "../../lib/projectCwd"
import {
  dirs,
  isWithinDir,
  join,
} from "../../helpers"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../../http"
import {
  findWorktree,
  isValidWorktreeName,
  parseWorktreeList,
  getMainWorktreeRoot,
} from "./worktreeUtils"
import type { WorktreeRaw } from "./worktreeUtils"
import { isGeneratedWorktreeBranch } from "../../../shared/worktreePath"
import { handleWorktreeList } from "./worktreeListRoute"
import { mapWithConcurrency } from "../../lib/mapWithConcurrency"
import {
  runWorktreeCommand,
  WORKTREE_NETWORK_TIMEOUT_MS,
  WORKTREE_SCAN_CONCURRENCY,
} from "./worktreeIo"

/** The request's JSON body, or null after answering a malformed one. */
async function readBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    const body = await readJsonBody<T | null>(req, { allowEmpty: true })
    if (body !== null && typeof body === "object") return body
    sendJson(res, 400, { error: "Invalid request body" })
    return null
  } catch (error) {
    sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, {
      error: error instanceof HttpBodyError ? error.message : "Invalid request body",
    })
    return null
  }
}

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
  const projectPath = await resolveProjectCwd(projectDir, dirName)
  const gitRoot = projectPath ? await getMainWorktreeRoot(projectPath) : null
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
      await handleWorktreeList(req, res, dirName)
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

      const body = await readBody<{ force?: boolean }>(req, res)
      if (!body) return
      const { force = false } = body
      try {
        const worktree = await findWorktree(gitRoot, worktreeName)
        if (!worktree) {
          sendJson(res, 404, { error: "Worktree not found" })
          return
        }
        await runWorktreeCommand("git", ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], {
          cwd: gitRoot,
        })

        if (isGeneratedWorktreeBranch(worktree.name, worktree.branch)) {
          try {
            const deleteFlag = force ? "-D" : "-d"
            await runWorktreeCommand("git", ["branch", deleteFlag, worktree.branch], {
              cwd: gitRoot,
            })
          } catch { /* branch may already be gone */ }
        }

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

      const parsed = await readBody<{ worktreeName?: string; title?: string; body?: string }>(req, res)
      if (!parsed) return
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

      try {
        const worktree = await findWorktree(gitRoot, worktreeName)
        if (!worktree?.branch) {
          sendJson(res, worktree ? 400 : 404, { error: worktree ? "Worktree has no branch to push" : "Worktree not found" })
          return
        }
        const { path: worktreePath, branch: branchName } = worktree

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

      const body = await readBody<{ confirm?: boolean; names?: string[]; maxAgeDays?: number }>(req, res)
      if (!body) return
      const { confirm, names, maxAgeDays = 7 } = body

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
              name: wt.name,
              path: wt.path,
              branch: wt.branch,
            })),
          }))
          return
        }

        // Perform cleanup on confirmed names
        const namesToRemove = new Set(names || stale.map((wt) => wt.name))
        const removed: string[] = []
        const errors: string[] = []

        for (const wt of stale) {
          if (!namesToRemove.has(wt.name)) continue
          try {
            await runWorktreeCommand("git", ["worktree", "remove", wt.path], { cwd: gitRoot })
            if (isGeneratedWorktreeBranch(wt.name, wt.branch)) {
              try {
                await runWorktreeCommand("git", ["branch", "-d", wt.branch], { cwd: gitRoot })
              } catch { /* */ }
            }
            removed.push(wt.name)
          } catch (err) {
            errors.push(`${wt.name}: ${err instanceof Error ? err.message : "unknown"}`)
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
