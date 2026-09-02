import { descriptorFor } from "../../shared/session/agent-descriptors"
import { formatFor, turnBoundaryLines } from "../../shared/session/agents"
import {
  copilotRuntime as transport,
  type CopilotPendingPermission,
  type CopilotPendingUserInput,
  type CopilotPermissionDecision,
} from "./copilotTransport"
import { fetchCopilotModels } from "./copilotModels"
import { join, randomUUID, readFile } from "../helpers"
import { storeFor } from "./index"
import { withTimeout } from "./timeout"
import { resolveSessionCwd } from "./sessionCwd"
import { initialCopilotScanState, parseCopilotUsageMetrics, type UsageCostRecord } from "./usageScanners"
import {
  AgentRuntimeError,
  selectAvailableDecision,
  type AgentRuntime,
  type ApprovalDecision,
  type ImageAttachment,
  type PendingApproval,
  type PendingQuestion,
  type SendOutcome,
  type SendRequest,
  type StartSessionRequest,
  type StartedSession,
  type UserQuestionAnswers,
} from "./runtimeTypes"

/**
 * GitHub Copilot CLI, over the single headless `copilot --stdio` connection in
 * `./copilotTransport`.
 *
 * Copilot is the odd one out in two ways this module has to keep visible: one
 * process serves every session, so there is nothing per-session to signal or to
 * find in a process listing; and the CLI owns its own session store, so a
 * deletion is an RPC — unlinking the transcript would leave the CLI still
 * offering a session whose bytes are gone.
 */

const descriptor = descriptorFor("copilot")

/** Prompt substituted when a message carries only images. */
const IMAGE_ONLY_PROMPT = "Describe the attached image(s)."

/** How long to wait for the CLI to write the first events of a new session. */
const TRANSCRIPT_POLL_ATTEMPTS = 20
const TRANSCRIPT_POLL_INTERVAL_MS = 50
/** A stuck `session.usage.getMetrics` must not hold the whole cost page. */
const LIVE_USAGE_TIMEOUT_MS = 5_000

/**
 * Map a turn position onto the durable event id the CLI forks at.
 *
 * Copilot does not truncate a transcript — `sessions.fork` takes the id of the
 * first event to drop. Three encodings of `turnUuid` reach here because the
 * client builds turn ids from whichever of them the transcript carried.
 */
function forkBoundary(
  lines: string[],
  turnIndex?: number,
  turnUuid?: string,
): string | undefined {
  const turns = turnBoundaryLines(formatFor("copilot"), lines).map((line) => {
    const event = JSON.parse(lines[line]) as Record<string, unknown>
    const data = event.data as Record<string, unknown>
    return {
      eventId: String(event.id),
      turnId: typeof data.turnId === "string" ? data.turnId : "",
    }
  })

  let targetIndex = -1
  if (turnUuid) {
    targetIndex = turns.findIndex(({ eventId, turnId }) => (
      turnUuid === eventId
      || turnUuid.endsWith(`@${eventId}`)
      || (turnId.length > 0 && turnUuid === `${turnId}@${eventId}`)
    ))
  }
  if (targetIndex < 0 && turnIndex !== undefined) targetIndex = turnIndex
  if (targetIndex < 0 || targetIndex >= turns.length - 1) return undefined
  return turns[targetIndex + 1].eventId
}

/** Images ride beside the prompt as blob attachments rather than in it. */
function buildAttachments(
  images: ImageAttachment[] | undefined,
): Array<{ type: "blob"; data: string; mimeType: string; displayName: string }> | undefined {
  if (!images?.length) return undefined
  return images.map((image, index) => ({
    type: "blob",
    data: image.data,
    mimeType: image.mediaType,
    displayName: `image-${index + 1}`,
  }))
}

/** Cogpit's access picker, as the two knobs Copilot exposes. */
function allowAll(mode: string | undefined): boolean {
  return mode === "bypassPermissions" || mode === "auto"
}

function agentMode(mode: string | undefined): string {
  if (mode === "plan") return "plan"
  return mode === "auto" ? "autopilot" : "interactive"
}

/**
 * A session title, made safe for a shell-rendered CLI.
 *
 * Quotes and control characters would break the name out of its own field, and
 * an unbounded one would fill the session list.
 */
function normalizeSessionName(name: string | undefined): string | undefined {
  const normalized = [...(name ?? "")]
    .map((character) => {
      const code = character.charCodeAt(0)
      return character === '"' || code < 32 || code === 127 ? " " : character
    })
    .join("")
    .trim()
  return normalized ? normalized.slice(0, 100) : undefined
}

function transcriptPath(sessionId: string): { fileName: string; filePath: string } {
  const fileName = descriptor.sessionFile.name(sessionId)
  return { fileName, filePath: join(storeFor("copilot").sessionsRoot() ?? "", fileName) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? ""
}

/**
 * Whether "always allow" is even offered.
 *
 * The CLI decides this per request kind and says so in the request itself; a
 * session grant Cogpit invented would be one the CLI never recorded.
 */
function canOfferSessionApproval(kind: string, request: Record<string, unknown>): boolean {
  if (request.managedApprovalRequired === true) return false
  if (kind === "commands" || kind === "shell" || kind === "write") {
    return request.canOfferSessionApproval === true
  }
  if (kind === "factory") return request.canPersistApproval === true
  if (kind === "mcp") return request.canOfferServerWideApproval !== false
  return false
}

/** Present one of Copilot's ten prompt variants as a tool call. */
export function normalizeCopilotPermission(
  pending: CopilotPendingPermission,
): PendingApproval {
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

  const availableDecisions: ApprovalDecision[] = canOfferSessionApproval(kind, request)
    ? ["allow", "allow_always", "deny"]
    : ["allow", "deny"]
  return {
    sessionId: pending.sessionId,
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

function wireDecision(decision: ApprovalDecision): CopilotPermissionDecision {
  if (decision === "allow") return { kind: "approve-once", approvedInteractively: true }
  if (decision === "allow_always") return { kind: "approve-for-session" }
  return { kind: "reject" }
}

function unavailableDecision(
  approval: PendingApproval,
  decision: ApprovalDecision,
): AgentRuntimeError {
  return new AgentRuntimeError(
    400,
    "COPILOT_PERMISSION_DECISION_UNAVAILABLE",
    `Decision '${decision}' is not available for this permission request`,
    {
      requestId: approval.requestId,
      availableDecisions: approval.availableDecisions,
    },
  )
}

function permissionFailure(error: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    502,
    "COPILOT_PERMISSION_FAILED",
    error instanceof Error ? error.message : "Failed to resolve Copilot permission request",
  )
}

// ── Questions ───────────────────────────────────────────────────────────────

export function normalizeCopilotQuestion(
  pending: CopilotPendingUserInput,
): PendingQuestion {
  return {
    sessionId: pending.sessionId,
    toolUseId: pending.requestId,
    askedAt: pending.askedAt,
    questions: [{
      question: pending.question,
      multiSelect: false,
      options: (pending.choices ?? []).map((label) => ({ label, hasPreview: false })),
    }],
  }
}

/** Pull the answer text out of the three encodings the dashboard may send. */
function answerText(
  pending: CopilotPendingUserInput,
  answers: UserQuestionAnswers,
): string | undefined {
  if (typeof answers === "string") return answers
  if (Array.isArray(answers)) {
    return answers.find((answer): answer is string => typeof answer === "string")
  }
  const exact = answers[pending.question]
  if (typeof exact === "string") return exact
  return Object.values(answers).find((answer): answer is string => typeof answer === "string")
}

/**
 * Match an answer to the request it belongs to.
 *
 * The client addresses questions by a Claude-shaped `toolUseId`, which Copilot
 * never issued, so an exact id match is only the first of three attempts.
 */
function matchingInput(
  pending: CopilotPendingUserInput[],
  questionId: string,
  answers: UserQuestionAnswers,
): CopilotPendingUserInput | undefined {
  const exact = pending.find((input) => input.requestId === questionId)
  if (exact) return exact
  if (typeof answers === "object" && !Array.isArray(answers)) {
    const byQuestion = pending.find((input) => Object.hasOwn(answers, input.question))
    if (byQuestion) return byQuestion
  }
  return pending.length === 1 ? pending[0] : undefined
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const copilotRuntime: AgentRuntime = {
  kind: "copilot",
  descriptor,

  async start(req: StartSessionRequest): Promise<StartedSession> {
    const sessionId = randomUUID()
    let opened = false
    try {
      await transport.createSession({
        sessionId,
        workingDirectory: req.cwd,
        ...(req.model ? { model: req.model } : {}),
        ...(req.effort ? { reasoningEffort: req.effort } : {}),
      })
      opened = true
      const sessionName = normalizeSessionName(req.name)
      if (sessionName) await transport.setSessionName(sessionId, sessionName)
      if (req.permissions?.mode) {
        await transport.setPermissionMode(sessionId, allowAll(req.permissions.mode))
      }
      const attachments = buildAttachments(req.images)
      await transport.send(sessionId, {
        prompt: req.message || IMAGE_ONLY_PROMPT,
        agentMode: agentMode(req.permissions?.mode),
        ...(attachments ? { attachments } : {}),
      })

      const { fileName, filePath } = transcriptPath(sessionId)
      let initialContent: string | undefined
      for (let attempt = 0; attempt < TRANSCRIPT_POLL_ATTEMPTS; attempt++) {
        try {
          initialContent = await readFile(filePath, "utf-8")
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_POLL_INTERVAL_MS))
        }
      }
      return { sessionId, dirName: req.dirName, fileName, filePath, initialContent }
    } catch (error) {
      // Order matters: a session that is still open has to be disconnected
      // before the CLI will delete it.
      if (opened) {
        if (transport.isSessionActive(sessionId)) {
          await transport.destroySession(sessionId).catch(() => {})
        }
        await transport.deleteSession(sessionId).catch(() => {})
      }
      throw new AgentRuntimeError(
        500,
        "SPAWN_FAILED",
        error instanceof Error ? error.message : "Failed to start Copilot session",
      )
    }
  },

  async send(sessionId, req: SendRequest): Promise<SendOutcome> {
    if (!transport.isSessionActive(sessionId)) {
      await transport.resumeSession(sessionId, {
        workingDirectory: await resolveSessionCwd(req.cwd, req.filePath),
        ...(req.model ? { model: req.model } : {}),
        ...(req.effort ? { reasoningEffort: req.effort } : {}),
      })
    } else if (req.model) {
      // A model switch carries the effort with it, so the dedicated effort call
      // is only needed when the model is unchanged.
      await transport.setModel(sessionId, req.model, req.effort)
    } else if (req.effort) {
      await transport.setReasoningEffort(sessionId, req.effort)
    }

    if (req.permissions?.mode) {
      await transport.setPermissionMode(sessionId, allowAll(req.permissions.mode))
    }

    const attachments = buildAttachments(req.images)
    const steering = transport.isTurnActive(sessionId)
    await transport.send(sessionId, {
      prompt: req.message || IMAGE_ONLY_PROMPT,
      agentMode: agentMode(req.permissions?.mode),
      ...(steering ? { mode: "immediate" } : {}),
      ...(attachments ? { attachments } : {}),
    })
    return { delivery: steering ? "steered" : "started" }
  },

  async interrupt(sessionId) {
    if (!transport.isTurnActive(sessionId)) return false
    await transport.abort(sessionId)
    return true
  },

  async stop(sessionId) {
    // No child process to signal: one headless CLI serves every session, so
    // stopping one is two RPCs and never a kill.
    if (!transport.isSessionActive(sessionId)) return false
    if (transport.isTurnActive(sessionId)) await transport.abort(sessionId)
    await transport.destroySession(sessionId)
    return true
  },

  async stopAll() {
    // Session-level, not turn-level: destroying is the only way to release the
    // CLI's per-session state, and a destroyed session can still be resumed.
    const sessions = transport.getActiveSessionIds()
    const results = await Promise.allSettled(
      sessions.map((sessionId) => transport.destroySession(sessionId)),
    )
    const stopped = results.filter((result) => result.status === "fulfilled").length
    return { stopped, failed: results.length - stopped }
  },

  async deleteSession(sessionId) {
    if (transport.isSessionActive(sessionId)) {
      if (transport.isTurnActive(sessionId)) await transport.abort(sessionId)
      await transport.destroySession(sessionId)
    }
    // The CLI owns the store: deleting the transcript alone would leave it
    // listing a session whose bytes are gone.
    await transport.deleteSession(sessionId)
  },

  activity(sessionId) {
    return {
      live: transport.isSessionActive(sessionId),
      running: transport.isTurnActive(sessionId),
    }
  },

  hasSession(sessionId) {
    return transport.isSessionActive(sessionId)
      || transport.getPendingPermissions(sessionId).length > 0
      || transport.getPendingUserInputs(sessionId).length > 0
  },

  listActive() {
    return transport.getActiveSessionIds().map((sessionId) => ({ sessionId }))
  },

  listPendingApprovals(sessionId) {
    return transport.getPendingPermissions(sessionId).map(normalizeCopilotPermission)
  },

  async respondToApproval(sessionId, requestId, decision) {
    const pending = transport
      .getPendingPermissions(sessionId)
      .find((candidate) => candidate.requestId === requestId)
    if (!pending) return false

    const approval = normalizeCopilotPermission(pending)
    if (!approval.availableDecisions.includes(decision)) {
      throw unavailableDecision(approval, decision)
    }
    try {
      return await transport.respondToPermission(sessionId, requestId, wireDecision(decision))
    } catch (error) {
      throw permissionFailure(error)
    }
  },

  async respondToAllApprovals(sessionId, decision) {
    const pending = transport.getPendingPermissions(sessionId)
    if (pending.length === 0) return { count: 0, toolNames: [] }

    const approvals = pending.map(normalizeCopilotPermission)
    // Validate the batch up front, the same way Codex does: a request that
    // cannot take this decision fails the call rather than silently getting a
    // narrower one.
    const planned = approvals.map((approval) => {
      const chosen = selectAvailableDecision(approval.availableDecisions, decision)
      if (!chosen) throw unavailableDecision(approval, decision)
      return { requestId: approval.requestId, decision: chosen }
    })

    try {
      for (const { requestId, decision: chosen } of planned) {
        // The CLI resolves requests as the turn advances, so each one is
        // re-checked: answering a request that already resolved is not an error.
        const stillPending = transport
          .getPendingPermissions(sessionId)
          .some((candidate) => candidate.requestId === requestId)
        if (!stillPending) continue

        const handled = await transport.respondToPermission(
          sessionId,
          requestId,
          wireDecision(chosen),
        )
        if (!handled && transport
          .getPendingPermissions(sessionId)
          .some((candidate) => candidate.requestId === requestId)) {
          throw new AgentRuntimeError(
            409,
            "COPILOT_PERMISSION_ALREADY_RESOLVED",
            "One or more permission requests were already resolved",
          )
        }
      }
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error
      throw permissionFailure(error)
    }
    return {
      count: pending.length,
      toolNames: [...new Set(approvals.map(({ toolName }) => toolName))],
    }
  },

  listPendingQuestions(sessionId) {
    return transport.getPendingUserInputs(sessionId).map(normalizeCopilotQuestion)
  },

  async answerQuestion(sessionId, questionId, answers) {
    const pending = matchingInput(
      transport.getPendingUserInputs(sessionId),
      questionId,
      answers,
    )
    if (!pending) {
      if (transport.isSessionActive(sessionId)) return false
      throw new AgentRuntimeError(
        404,
        "SESSION_NOT_LIVE",
        "Session not found or not a live interactive session",
      )
    }

    const answer = answerText(pending, answers)
    if (answer === undefined) {
      throw new AgentRuntimeError(
        400,
        "INVALID_REQUEST",
        "answers must contain an answer to the pending question",
      )
    }
    if (pending.allowFreeform === false && pending.choices && !pending.choices.includes(answer)) {
      throw new AgentRuntimeError(
        400,
        "INVALID_REQUEST",
        "answer must be one of the available choices",
      )
    }
    try {
      transport.answerUserInput(sessionId, pending.requestId, {
        answer,
        wasFreeform: !(pending.choices?.includes(answer) ?? false),
      })
    } catch (error) {
      throw new AgentRuntimeError(
        502,
        "COPILOT_USER_INPUT_FAILED",
        error instanceof Error ? error.message : "Failed to answer Copilot question",
      )
    }
    return true
  },

  listModels: fetchCopilotModels,

  async liveUsageRecords(alreadyCounted) {
    // Detailed token metrics reach the transcript only at shutdown. While a
    // session is still open, its cumulative snapshot is folded in after
    // subtracting every durable snapshot already counted.
    const records: UsageCostRecord[] = []
    await Promise.all(transport.getActiveSessionIds().map(async (sessionId) => {
      try {
        const metrics = await withTimeout(
          transport.getSessionUsage(sessionId),
          LIVE_USAGE_TIMEOUT_MS,
          "copilot session usage",
        )
        const state = initialCopilotScanState(sessionId)
        for (const [model, totals] of alreadyCounted.get(sessionId) ?? []) {
          state.lastUsageByModel.set(model, totals)
        }
        records.push(...parseCopilotUsageMetrics(metrics, state, Date.now()))
      } catch {
        // Live usage is additive; a failed control RPC must not hide durable data.
      }
    }))
    return records
  },

  async fork(sessionId, at) {
    const toEventId = forkBoundary(at.lines, at.turnIndex, at.turnUuid)
    const forked = await transport.forkSession(sessionId, toEventId ? { toEventId } : {})
    return { sessionId: forked.sessionId, fileName: descriptor.sessionFile.name(forked.sessionId) }
  },

  async describeRuntime() {
    try {
      return { available: true, quota: await transport.getAccountQuota(), errors: {} }
    } catch (error) {
      return {
        available: false,
        quota: null,
        errors: { runtime: error instanceof Error ? error.message : String(error) },
      }
    }
  },

  async shutdown() {
    await transport.shutdown()
  },
}
