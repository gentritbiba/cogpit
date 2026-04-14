import { persistentSessions, activeProcesses, sendJson } from "../helpers"
import { sdkSessions, resolvePermission, resolveAllPermissions, getSDKPermissions } from "../sdk-session"
import type { UseFn } from "../helpers"

export function registerPermissionRoutes(use: UseFn) {
  use("/api/permissions", (req, res, next) => {
    const url = req.url ?? ""

    // GET /api/permissions/:sessionId — return pending permission requests
    const getMatch = url.match(/^\/([^/?]+)$/)
    if (req.method === "GET" && getMatch) {
      const sessionId = decodeURIComponent(getMatch[1])

      // Check SDK sessions first (real-time canUseTool permissions)
      const sdkPerms = getSDKPermissions(sessionId)
      if (sdkPerms.length > 0) {
        sendJson(res, 200, { permissions: sdkPerms })
        return
      }

      // Fallback: check legacy CLI persistent sessions
      const ps = persistentSessions.get(sessionId)
      if (ps) {
        const permissions = Array.from(ps.pendingPermissions.values())
        sendJson(res, 200, { permissions })
        return
      }

      sendJson(res, 200, { permissions: [] })
      return
    }

    // POST /api/permissions/:sessionId/respond — approve/deny a single tool
    const respondMatch = url.match(/^\/([^/?]+)\/respond$/)
    if (req.method === "POST" && respondMatch) {
      const sessionId = decodeURIComponent(respondMatch[1])
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", () => {
        try {
          const { requestId, behavior } = JSON.parse(body)

          if (!requestId) {
            sendJson(res, 400, { error: "requestId is required" })
            return
          }
          if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
            sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
            return
          }

          // SDK session path: resolves the canUseTool promise directly
          if (sdkSessions.has(sessionId)) {
            const result = resolvePermission(sessionId, requestId, behavior)
            if (!result.found) {
              sendJson(res, 404, { error: "Permission request not found or already resolved" })
              return
            }
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              toolName: result.toolName,
            })
            return
          }

          // Fallback: legacy CLI session (kill + retry approach)
          const ps = persistentSessions.get(sessionId)
          if (!ps) {
            sendJson(res, 404, { error: "Session not found" })
            return
          }

          const permReq = ps.pendingPermissions.get(requestId)
          if (!permReq) {
            sendJson(res, 404, { error: "Permission request not found or already resolved" })
            return
          }

          ps.pendingPermissions.delete(requestId)

          if (behavior === "deny") {
            sendJson(res, 200, { success: true, action: "denied" })
            return
          }

          const toolName = permReq.toolName
          const hasAlready = ps.permArgs.some(
            (a, i) => a === "--allowedTools" && ps.permArgs[i + 1] === toolName
          )
          if (!hasAlready) {
            ps.permArgs = [...ps.permArgs, "--allowedTools", toolName]
          }

          if (ps.pendingPermissions.size === 0) {
            if (!ps.dead) {
              ps.dead = true
              try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
              activeProcesses.delete(sessionId)
            }
            sendJson(res, 200, { success: true, action: "allowed", shouldRetry: true, toolName })
          } else {
            sendJson(res, 200, { success: true, action: "allowed", shouldRetry: false, toolName })
          }
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
      return
    }

    // POST /api/permissions/:sessionId/respond-all — batch approve/deny
    const respondAllMatch = url.match(/^\/([^/?]+)\/respond-all$/)
    if (req.method === "POST" && respondAllMatch) {
      const sessionId = decodeURIComponent(respondAllMatch[1])
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", () => {
        try {
          const { behavior } = JSON.parse(body)

          if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
            sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
            return
          }

          // SDK session path
          if (sdkSessions.has(sessionId)) {
            const toolNames = resolveAllPermissions(sessionId, behavior)
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              count: toolNames.length,
              toolNames,
            })
            return
          }

          // Fallback: legacy CLI session
          const ps = persistentSessions.get(sessionId)
          if (!ps) {
            sendJson(res, 404, { error: "Session not found" })
            return
          }

          const pending = Array.from(ps.pendingPermissions.values())
          const toolNames = [...new Set(pending.map((p) => p.toolName))]
          ps.pendingPermissions.clear()

          if (behavior === "deny") {
            sendJson(res, 200, { success: true, action: "denied", count: pending.length })
            return
          }

          for (const toolName of toolNames) {
            const hasAlready = ps.permArgs.some(
              (a, i) => a === "--allowedTools" && ps.permArgs[i + 1] === toolName
            )
            if (!hasAlready) {
              ps.permArgs = [...ps.permArgs, "--allowedTools", toolName]
            }
          }

          if (!ps.dead) {
            ps.dead = true
            try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
            activeProcesses.delete(sessionId)
          }

          sendJson(res, 200, {
            success: true,
            action: "allowed",
            count: pending.length,
            toolNames,
            shouldRetry: true,
          })
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
      return
    }

    next()
  })
}
