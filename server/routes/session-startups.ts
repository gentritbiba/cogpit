import { assertWorktreeStartAccess } from "../sessionStartup/authorization"
import { worktreeStartups } from "../sessionStartup/readiness"
import { dirs, join } from "../helpers"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { commandScope } from "../lib/durableSend"
import { markDecided } from "../edition"
import { resolveProjectCwd } from "../lib/projectCwd"
import { RouteError, ErrorCodes, sendError } from "../lib/routeError"

/** The caller's worktree startups that are still waiting to release their first prompt. */
export function registerSessionStartupRoutes(use: UseFn): void {
  use("/api/session-startups", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "/cancel") return next()
    try {
      assertWorktreeStartAccess(req)
      markDecided(req)
      if (url.pathname === "/cancel") {
        if (req.method !== "POST") return next()
        withJsonBody<{ id?: unknown }>(req, res, async (body) => {
          try {
            assertWorktreeStartAccess(req)
            if (typeof body.id !== "string") throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Startup id required")
            worktreeStartups.cancel(commandScope(req), body.id)
            sendJson(res, 200, { ok: true })
          } catch (error) { sendError(res, error instanceof Error ? error : new Error("Unable to cancel startup")) }
        }, { maxBytes: 1024 })
        return
      }
      if (req.method !== "GET") return next()
      const cwd = url.searchParams.get("cwd") || await (async () => {
        const dirName = url.searchParams.get("dirName")
        if (!dirName || dirName.includes("/") || dirName.includes("\\") || dirName.includes("\0") || dirName === "..") return null
        return resolveProjectCwd(join(dirs.PROJECTS_DIR, dirName), dirName)
      })()
      if (!cwd) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Project cwd or dirName is required")
      sendJson(res, 200, { startups: await worktreeStartups.list(commandScope(req), cwd) })
    } catch (error) { sendError(res, error instanceof Error ? error : new Error("Unable to read worktree startups")) }
  })
}
