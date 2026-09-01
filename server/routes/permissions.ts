import { sendJson, type UseFn } from "../http"
import { getToolSummary } from "../../shared/session/toolSummary"
import type { MissionControlPermission } from "../../shared/contracts/missionControl"
import { persistentSessions, activeProcesses } from "../helpers"
import { sdkSessions, resolvePermission, resolveAllPermissions, getSDKPermissions } from "../sdk-session"
import {
  codexAppServer,
  type ApprovalDecision,
  type CodexAppServer,
  type PendingApproval,
} from "../codex-app-server"
import {
  copilotRuntime,
  type CopilotExitPlanResponse,
  type CopilotPendingPermission,
  type CopilotPermissionDecision,
  type CopilotRuntime,
} from "../copilot-runtime"

export type CodexApprovalClient = Pick<
  CodexAppServer,
  "listPendingApprovals" | "respondApproval" | "listApprovalThreadIds"
>

export type CopilotPermissionClient = Pick<
  CopilotRuntime,
  | "getPendingPermissions"
  | "respondToPermission"
  | "getPendingExitPlans"
  | "answerExitPlan"
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

/** Convert Copilot's prompt variants to the permission bar's existing tool shape. */
export function normalizeCopilotPermission(
  pending: CopilotPendingPermission,
): FrontendPermissionRequest {
  const request = asRecord(pending.request)
  const rawRequest = asRecord(pending.rawRequest)
  const kind = typeof request.kind === "string" ? request.kind : "tool"
  const requestsSandboxBypass = request.requestSandboxBypass === true
    || rawRequest.requestSandboxBypass === true
  const description = firstString(
    request.warning,
    rawRequest.warning,
    request.requestSandboxBypassReason,
    rawRequest.requestSandboxBypassReason,
    request.intention,
    request.toolDescription,
    request.hookMessage,
    request.description,
  )
  const input: Record<string, unknown> = {}
  let toolName = firstString(request.toolName) || "Tool"
  let title = "Allow tool use"
  let blockedPath: string | undefined

  if (kind === "commands" || kind === "shell") {
    toolName = "Bash"
    title = "Run command"
    if (typeof request.fullCommandText === "string") input.command = request.fullCommandText
  } else if (kind === "write" || kind === "read") {
    toolName = kind === "write" ? "Write" : "Read"
    title = kind === "write" ? "Write file" : "Read file"
    blockedPath = firstString(request.fileName, request.path) || undefined
    if (blockedPath) input.file_path = blockedPath
    if (kind === "write" && typeof request.diff === "string") input.diff = request.diff
  } else if (kind === "path") {
    const accessKind = typeof request.accessKind === "string" ? request.accessKind : "read"
    toolName = accessKind === "write" ? "Write" : accessKind === "shell" ? "Bash" : "Read"
    title = `${accessKind === "write" ? "Write" : "Access"} path`
    const paths = Array.isArray(request.paths)
      ? request.paths.filter((path): path is string => typeof path === "string")
      : []
    blockedPath = paths[0]
    if (blockedPath) input.file_path = blockedPath
    if (paths.length > 1) input.paths = paths
  } else if (kind === "url") {
    toolName = "WebFetch"
    title = "Allow network access"
    if (typeof request.url === "string") input.url = request.url
  } else if (kind === "mcp" || kind === "custom-tool") {
    title = kind === "mcp" ? "Run MCP tool" : "Run tool"
    if (request.args !== undefined) input.args = request.args
    if (typeof request.serverName === "string") input.serverName = request.serverName
  } else {
    title = kind === "memory" ? "Update memory" : `Allow ${kind.replaceAll("-", " ")}`
    Object.assign(input, request)
  }

  if (requestsSandboxBypass) {
    title = `${title} outside sandbox`
    input.request_sandbox_bypass = true
  }

  const canOfferSessionApproval = canOfferCopilotSessionApproval(kind, request)
  const availableDecisions: ApprovalDecision[] = canOfferSessionApproval
    ? ["allow", "allow_always", "deny"]
    : ["allow", "deny"]
  return {
    requestId: pending.requestId,
    toolName,
    input,
    toolUseId: firstString(request.toolCallId) || pending.requestId,
    title,
    displayName: title,
    ...(description ? { description, decisionReason: description } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    timestamp: pending.requestedAt,
    availableDecisions,
  }
}

function canOfferCopilotSessionApproval(
  kind: string,
  request: Record<string, unknown>,
): boolean {
  if (request.managedApprovalRequired === true) return false
  if (kind === "commands" || kind === "shell" || kind === "write") {
    return request.canOfferSessionApproval === true
  }
  if (kind === "factory") return request.canPersistApproval === true
  if (kind === "mcp") return request.canOfferServerWideApproval !== false
  return false
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? ""
}

function copilotDecision(behavior: ApprovalDecision): CopilotPermissionDecision {
  if (behavior === "allow") return { kind: "approve-once", approvedInteractively: true }
  if (behavior === "allow_always") return { kind: "approve-for-session" }
  return { kind: "reject" }
}

/**
 * Pick a batch decision without silently escalating access. "Always allow"
 * may safely degrade to one-time allow, but one-time allow never broadens to a
 * session grant and deny never changes into an allow.
 */
function selectCodexBatchDecision(
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

function sendCopilotPermissionError(
  res: Parameters<typeof sendJson>[0],
  error: unknown,
): void {
  sendJson(res, 502, {
    error: error instanceof Error ? error.message : "Failed to resolve Copilot permission request",
    code: "COPILOT_PERMISSION_FAILED",
  })
}

/**
 * Pending requests for one session, in provider precedence order.
 *
 * Shared by the per-session route and the cross-session listing so both cannot
 * drift on which provider wins.
 */
export function collectPendingPermissions(
  sessionId: string,
  codex: CodexApprovalClient = codexAppServer,
  copilot: CopilotPermissionClient = copilotRuntime,
): FrontendPermissionRequest[] | ReturnType<typeof getSDKPermissions> {
  // Check SDK sessions first (real-time canUseTool permissions)
  const sdkPerms = getSDKPermissions(sessionId)
  if (sdkPerms.length > 0) return sdkPerms

  // Codex app-server approvals are live requests: answering them resumes
  // the turn directly, with no process kill/retry cycle.
  const codexPerms = codex.listPendingApprovals(sessionId).map(normalizeCodexApproval)
  if (codexPerms.length > 0) return codexPerms

  const copilotPerms = copilot
    .getPendingPermissions(sessionId)
    .map(normalizeCopilotPermission)
  if (copilotPerms.length > 0) return copilotPerms

  // Fallback: check legacy CLI persistent sessions
  const ps = persistentSessions.get(sessionId)
  if (ps) return Array.from(ps.pendingPermissions.values())

  return []
}

/**
 * Every session id that could currently hold a pending request.
 *
 * Live approval registries expose their own session IDs, including sessions
 * that are not currently open in the UI.
 */
export function listPermissionSessionIds(
  codex: CodexApprovalClient = codexAppServer,
  copilot: CopilotPermissionClient = copilotRuntime,
): string[] {
  const ids = new Set<string>()
  for (const id of sdkSessions.keys()) ids.add(id)
  for (const id of persistentSessions.keys()) ids.add(id)
  for (const id of codex.listApprovalThreadIds()) ids.add(id)
  for (const pending of copilot.getPendingPermissions()) ids.add(pending.sessionId)
  return [...ids]
}

/**
 * Reduce one request to what a dashboard card renders.
 *
 * The raw `input` is the complete tool input — for a pending Write, the entire
 * file being written. This list is polled app-wide, so shipping it would put
 * that payload on the wire every few seconds for every connected client,
 * including remote and tunnel ones. The card only ever shows a one-line
 * summary, so that is all it gets. (The per-session route below still returns
 * the full input; the permission bar needs it to render.)
 */
function summarizeRequest(
  sessionId: string,
  request: ReturnType<typeof collectPendingPermissions>[number],
): MissionControlPermission {
  const input = asRecord(request.input)
  const available = (request as { availableDecisions?: MissionControlPermission["availableDecisions"] })
    .availableDecisions
  return {
    sessionId,
    requestId: request.requestId,
    toolName: request.toolName,
    summary: getToolSummary({ name: request.toolName, input }),
    ...(request.title && { title: request.title }),
    ...(request.description && { description: request.description }),
    ...(available && { availableDecisions: available }),
    timestamp: request.timestamp,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function registerPermissionRoutes(
  use: UseFn,
  codex: CodexApprovalClient = codexAppServer,
  copilot: CopilotPermissionClient = copilotRuntime,
) {
  use("/api/permissions", (req, res, next) => {
    const url = req.url ?? ""

    // GET /api/permissions — every pending request, grouped by session. Powers
    // the Mission Control grid, which must surface requests for sessions that
    // are not open.
    if (req.method === "GET" && (url === "" || url === "/" || url.startsWith("?"))) {
      const bySession: Record<string, MissionControlPermission[]> = {}
      for (const sessionId of listPermissionSessionIds(codex, copilot)) {
        const permissions = collectPendingPermissions(sessionId, codex, copilot)
        if (permissions.length > 0) {
          bySession[sessionId] = permissions.map((r) => summarizeRequest(sessionId, r))
        }
      }
      const plansBySession: Record<
        string,
        Array<{ sessionId: string; requestId: string; summary: string }>
      > = {}
      for (const { sessionId, requestId, summary } of copilot.getPendingExitPlans()) {
        const plans = plansBySession[sessionId] ??= []
        plans.push({ sessionId, requestId, summary })
      }
      sendJson(res, 200, { bySession, plansBySession })
      return
    }

    // GET /api/permissions/:sessionId — return pending permission requests
    const getMatch = url.match(/^\/([^/?]+)$/)
    if (req.method === "GET" && getMatch) {
      const sessionId = decodeURIComponent(getMatch[1])
      sendJson(res, 200, {
        permissions: collectPendingPermissions(sessionId, codex, copilot),
        plan: copilot.getPendingExitPlans(sessionId)[0] ?? null,
      })
      return
    }

    const planMatch = url.match(/^\/([^/?]+)\/plan$/)
    if (req.method === "POST" && planMatch) {
      const sessionId = decodeURIComponent(planMatch[1])
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", () => {
        try {
          const { requestId, approved, selectedAction, feedback } = JSON.parse(body)
          if (typeof requestId !== "string" || !requestId) {
            sendJson(res, 400, { error: "requestId is required" })
            return
          }
          if (typeof approved !== "boolean") {
            sendJson(res, 400, { error: "approved must be a boolean" })
            return
          }
          if (selectedAction !== undefined && typeof selectedAction !== "string") {
            sendJson(res, 400, { error: "selectedAction must be a string" })
            return
          }
          if (feedback !== undefined && typeof feedback !== "string") {
            sendJson(res, 400, { error: "feedback must be a string" })
            return
          }
          const pending = copilot
            .getPendingExitPlans(sessionId)
            .find((plan) => plan.requestId === requestId)
          if (!pending) {
            sendJson(res, 404, { error: "Plan request not found or already resolved" })
            return
          }
          const response: CopilotExitPlanResponse = {
            approved,
            ...(selectedAction ? { selectedAction } : {}),
            ...(feedback ? { feedback } : {}),
          }
          try {
            copilot.answerExitPlan(sessionId, requestId, response)
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Failed to answer Copilot plan",
            })
            return
          }
          sendJson(res, 200, { success: true })
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
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

          const copilotPending = copilot
            .getPendingPermissions(sessionId)
            .find((pending) => pending.requestId === requestId)
          if (copilotPending) {
            const permission = normalizeCopilotPermission(copilotPending)
            const decision = behavior as ApprovalDecision
            if (!permission.availableDecisions.includes(decision)) {
              sendJson(res, 400, {
                error: `Decision '${decision}' is not available for this permission request`,
                code: "COPILOT_PERMISSION_DECISION_UNAVAILABLE",
                requestId,
                availableDecisions: permission.availableDecisions,
              })
              return
            }
            try {
              const handled = await copilot.respondToPermission(
                sessionId,
                requestId,
                copilotDecision(decision),
              )
              if (!handled) {
                sendJson(res, 404, { error: "Permission request not found or already resolved" })
                return
              }
            } catch (error) {
              sendCopilotPermissionError(res, error)
              return
            }
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

          const copilotPending = copilot.getPendingPermissions(sessionId)
          if (copilotPending.length > 0) {
            const permissions = copilotPending.map(normalizeCopilotPermission)
            try {
              for (const [index, pending] of copilotPending.entries()) {
                const stillPending = copilot
                  .getPendingPermissions(sessionId)
                  .some(({ requestId }) => requestId === pending.requestId)
                if (!stillPending) continue

                const available = permissions[index].availableDecisions
                const decision = behavior === "allow_always" && !available.includes("allow_always")
                  ? "allow"
                  : behavior as ApprovalDecision
                const handled = await copilot.respondToPermission(
                  sessionId,
                  pending.requestId,
                  copilotDecision(decision),
                )
                if (!handled && copilot
                  .getPendingPermissions(sessionId)
                  .some(({ requestId }) => requestId === pending.requestId)) {
                  sendJson(res, 409, {
                    error: "One or more permission requests were already resolved",
                    code: "COPILOT_PERMISSION_ALREADY_RESOLVED",
                  })
                  return
                }
              }
            } catch (error) {
              sendCopilotPermissionError(res, error)
              return
            }
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              count: copilotPending.length,
              toolNames: [...new Set(permissions.map(({ toolName }) => toolName))],
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
