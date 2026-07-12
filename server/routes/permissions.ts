import { persistentSessions, activeProcesses, sendJson } from "../helpers"
import { sdkSessions, resolvePermission, resolveAllPermissions, getSDKPermissions } from "../sdk-session"
import {
  codexAppServer,
  type ApprovalDecision,
  type CodexAppServer,
  type PendingApproval,
} from "../codex-app-server"
import type { UseFn } from "../helpers"

export type CodexApprovalClient = Pick<
  CodexAppServer,
  "listPendingApprovals" | "respondApproval"
>

interface FrontendPermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title: string
  displayName: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  timestamp: number
  availableDecisions: ApprovalDecision[]
}

/** Convert provider-native approval data to the existing permission bar shape. */
export function normalizeCodexApproval(
  approval: PendingApproval,
): FrontendPermissionRequest {
  const command = approval.kind === "commandExecution"
  const network =
    approval.networkApprovalContext &&
    typeof approval.networkApprovalContext === "object" &&
    !Array.isArray(approval.networkApprovalContext)
      ? (approval.networkApprovalContext as Record<string, unknown>)
      : null
  const networkHost =
    network && typeof network.host === "string" ? network.host : null
  const networkProtocol =
    network && typeof network.protocol === "string"
      ? network.protocol.replace(/:$/, "")
      : "https"
  const networkPort =
    network && (typeof network.port === "number" || typeof network.port === "string")
      ? `:${String(network.port)}`
      : ""
  const input: Record<string, unknown> = {}
  if (command) {
    if (approval.command) input.command = approval.command
    if (approval.cwd) input.cwd = approval.cwd
    if (network) input.networkApprovalContext = network
    if (networkHost) {
      input.url = `${networkProtocol}://${networkHost}${networkPort}`
    }
    for (const field of [
      "commandActions",
      "additionalPermissions",
      "proposedExecpolicyAmendment",
      "proposedNetworkPolicyAmendments",
    ]) {
      if (approval.params[field] !== undefined) {
        input[field] = approval.params[field]
      }
    }
  } else {
    if (approval.grantRoot) input.file_path = approval.grantRoot
    if (approval.params.changes !== undefined) {
      input.changes = approval.params.changes
    }
  }
  if (approval.reason) input.reason = approval.reason
  const networkRequest = command && networkHost !== null
  return {
    requestId: String(approval.requestId),
    toolName: networkRequest ? "WebFetch" : command ? "Bash" : "Write",
    input,
    toolUseId: approval.itemId,
    title: networkRequest
      ? "Allow network access"
      : command
        ? "Run command"
        : "Apply file changes",
    displayName: networkRequest
      ? "Network access"
      : command
        ? "Command execution"
        : "File change",
    description: approval.reason,
    decisionReason: approval.reason,
    blockedPath: command ? approval.cwd : approval.grantRoot,
    timestamp: approval.requestedAt,
    availableDecisions: [...approval.availableDecisions],
  }
}

/**
 * Pick a batch decision without silently escalating access. "Always allow"
 * may safely degrade to one-time allow, but one-time allow never broadens to a
 * session grant and deny never changes into an allow.
 */
export function selectCodexBatchDecision(
  approval: PendingApproval,
  requested: ApprovalDecision,
): ApprovalDecision | null {
  if (approval.availableDecisions.includes(requested)) return requested
  if (
    requested === "allow_always" &&
    approval.availableDecisions.includes("allow")
  ) {
    return "allow"
  }
  return null
}

function sendUnavailableDecision(
  res: Parameters<typeof sendJson>[0],
  approval: PendingApproval,
  decision: ApprovalDecision,
): void {
  sendJson(res, 400, {
    error: `Decision '${decision}' is not available for this approval request`,
    code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
    requestId: String(approval.requestId),
    availableDecisions: approval.availableDecisions,
  })
}

function findCodexApproval(
  client: CodexApprovalClient,
  threadId: string,
  requestId: string,
): PendingApproval | undefined {
  return client
    .listPendingApprovals(threadId)
    .find((approval) => String(approval.requestId) === requestId)
}

function sendCodexApprovalError(res: Parameters<typeof sendJson>[0], error: unknown): void {
  sendJson(res, 502, {
    error:
      error instanceof Error
        ? error.message
        : "Failed to resolve Codex approval request",
    code: "CODEX_APPROVAL_FAILED",
  })
}

export function registerPermissionRoutes(
  use: UseFn,
  codex: CodexApprovalClient = codexAppServer,
) {
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

      // Codex app-server approvals are live requests: answering them resumes
      // the turn directly, with no process kill/retry cycle.
      const codexPerms = codex
        .listPendingApprovals(sessionId)
        .map(normalizeCodexApproval)
      if (codexPerms.length > 0) {
        sendJson(res, 200, { permissions: codexPerms })
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
      req.on("end", async () => {
        try {
          const { requestId, behavior } = JSON.parse(body)

          if (typeof requestId !== "string" || !requestId) {
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

          const codexApproval = findCodexApproval(codex, sessionId, requestId)
          if (codexApproval) {
            const decision = behavior as ApprovalDecision
            if (!codexApproval.availableDecisions.includes(decision)) {
              sendUnavailableDecision(res, codexApproval, decision)
              return
            }
            try {
              await codex.respondApproval(codexApproval, decision)
            } catch (error) {
              sendCodexApprovalError(res, error)
              return
            }
            const permission = normalizeCodexApproval(codexApproval)
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              toolName: permission.toolName,
              shouldRetry: false,
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
      req.on("end", async () => {
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

          const codexPending = codex.listPendingApprovals(sessionId)
          if (codexPending.length > 0) {
            const requestedDecision = behavior as ApprovalDecision
            const decisions: Array<{
              approval: PendingApproval
              decision: ApprovalDecision
            }> = []
            for (const approval of codexPending) {
              const decision = selectCodexBatchDecision(
                approval,
                requestedDecision,
              )
              if (!decision) {
                sendUnavailableDecision(res, approval, requestedDecision)
                return
              }
              decisions.push({ approval, decision })
            }
            try {
              await Promise.all(
                decisions.map(({ approval, decision }) =>
                  codex.respondApproval(approval, decision),
                ),
              )
            } catch (error) {
              sendCodexApprovalError(res, error)
              return
            }
            const toolNames = [
              ...new Set(
                codexPending.map(
                  (approval) => normalizeCodexApproval(approval).toolName,
                ),
              ),
            ]
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              count: codexPending.length,
              toolNames,
              shouldRetry: false,
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
