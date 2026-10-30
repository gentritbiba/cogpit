import { assertSetupAccess } from "../worktreeSetup/authorization"
import { dirs, join } from "../helpers"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { commandScope } from "../lib/durableSend"
import { markDecided } from "../edition"
import { resolveProjectCwd } from "../lib/projectCwd"
import { RouteError, ErrorCodes, sendError } from "../lib/routeError"
import { worktreeSetupService } from "../worktreeSetup/service"
import { worktreeSetupStore } from "../worktreeSetup/store"

export function registerWorktreeSetupRoutes(use: UseFn): void {
  use("/api/worktree-setup", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname !== "/") return next()
    try {
      assertSetupAccess(req)
      markDecided(req)
      const cwd = url.searchParams.get("cwd") || await (async () => {
        const dirName = url.searchParams.get("dirName")
        if (!dirName || dirName.includes("/") || dirName.includes("\\") || dirName.includes("\0") || dirName === "..") return null
        return resolveProjectCwd(join(dirs.PROJECTS_DIR, dirName), dirName)
      })()
      if (!cwd) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Project cwd or dirName is required")
      const project = await worktreeSetupStore.project(commandScope(req), cwd)
      if (req.method === "GET") { sendJson(res, 200, { projectCwd: project.cwd, ...project.state }); return }
      if (req.method !== "PUT" && req.method !== "POST") return next()
      withJsonBody<{ command?: unknown; trusted?: unknown; timeoutMs?: unknown; operationId?: unknown; action?: unknown }>(req, res, async (body) => {
        try {
          assertSetupAccess(req)
          if (req.method === "PUT") await worktreeSetupStore.configure(project, body)
          else {
            if (typeof body.operationId !== "string" || (body.action !== "cancel" && body.action !== "retry")) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Operation id and retry/cancel action required")
            worktreeSetupService.act(project, body.operationId, body.action)
          }
          sendJson(res, 200, { projectCwd: project.cwd, ...project.state })
        } catch (error) { sendError(res, error instanceof Error ? error : new Error("Worktree setup failed")) }
      }, { maxBytes: 16_384 })
    } catch (error) { sendError(res, error instanceof Error ? error : new Error("Worktree setup failed")) }
  })
}
