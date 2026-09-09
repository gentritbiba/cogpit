import type { ChildProcess } from "node:child_process"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { asRecord } from "../../shared/objects"
import {
  CODEX_CLIENT_CAPABILITIES,
  codexAppServer,
  type InitializeResult,
  type JsonObject,
  type CodexThread,
  type PendingApproval as CodexApproval,
} from "./codexAppServer"
import {
  createInterface,
  join,
  readFile,
  spawn,
  unlink,
} from "../helpers"
import { fetchCodexModels } from "./codexModels"
import { codexQuestions, type CodexAsyncQuestion } from "./codexQuestions"
import { friendlySpawnError } from "./spawnError"
import { cleanupTempFiles, writeTempImageFiles } from "./tempImages"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { browserAgentEnv } from "../browser/agentEnv"
import { NO_COGPIT_SESSION } from "../browser/paths"
import {
  getCodexThreadIdentity,
  isCodexAppServerUnavailable,
  continueCodexExecution,
  startCodexExecution,
  type CodexExecutionOptions,
} from "./codexExecution"
import {
  activeProcesses,
  persistentSessions,
  terminateTrackedSession,
  type PersistentSession,
} from "../processRegistry"
import { findNewestCodexSessionForCwd } from "../sessionPaths"
import { resolveSessionCwd } from "./sessionCwd"
import { storeFor } from "./index"
import {
  AgentRuntimeError,
  selectAvailableDecision,
  type AgentRuntime,
  type ApprovalDecision,
  type PendingApproval,
  type SendOutcome,
  type SendRequest,
  type UserQuestionAnswers,
  type StartSessionRequest,
  type StartedSession,
  type TurnResult,
} from "./runtimeTypes"

/**
 * Codex, over the persistent `codex app-server --stdio` connection in
 * `./codexAppServer`, with the pre-app-server `codex exec` CLI as a fallback.
 *
 * The fallback is selected at runtime, not at build time: an installed CLI that
 * predates the app-server answers `initialize` with -32601 (or is missing
 * entirely), and `isCodexAppServerUnavailable` is what tells the two apart. The
 * three copies of that CLI path this module replaced had drifted — one handled
 * images, one capped stdout at half the lines, only one synthesised a result
 * from the exit code — so there is one of each here now.
 */

const descriptor = descriptorFor("codex")

/** Prompt substituted when a message carries only images. */
export const CODEX_IMAGE_ONLY_PROMPT = "Please use the attached image or images as context."

/** How long to wait for the CLI to write a rollout we can recognise as ours. */
const SESSION_DISCOVERY_TIMEOUT_MS = 60_000
const SESSION_DISCOVERY_INTERVAL_MS = 100
/** Enough of the CLI's stdout to seed the transcript view before it flushes. */
const MAX_INITIAL_STDOUT_LINES = 128

interface CodexIdentity {
  sessionId: string
  fileName: string
  filePath: string
}

function sessionsRoot(): string {
  return storeFor("codex").sessionsRoot() ?? ""
}

function executionOptions(
  req: StartSessionRequest | (SendRequest & { cwd: string }),
): CodexExecutionOptions {
  return {
    cwd: req.cwd,
    message: req.message,
    images: req.images,
    permissions: req.permissions,
    model: req.model,
    effort: req.effort,
    fastMode: req.fastMode,
  }
}

type ThreadSettings = Omit<CodexExecutionOptions, "message" | "images">

// Question answers omit session settings. Preserve them so replies keep the
// thread's access mode, working directory, and model options.
const rememberedSettings = new Map<string, ThreadSettings>()

function rememberThreadSettings(sessionId: string, options: CodexExecutionOptions): void {
  const { message: _message, images: _images, ...settings } = options
  rememberedSettings.set(sessionId, settings)
}

/**
 * Watch the sessions tree for the rollout this spawn just created.
 *
 * Codex is the only agent that neither takes a session id nor reports the path
 * it wrote, so its session has to be recognised by elimination: newer than the
 * spawn, unseen before it, and carrying the right cwd.
 */
async function waitForNewSession(
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
  timeoutMs = SESSION_DISCOVERY_TIMEOUT_MS,
): Promise<CodexIdentity | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = await findNewestCodexSessionForCwd(cwd, knownPaths, startedAt)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, SESSION_DISCOVERY_INTERVAL_MS))
  }
  return null
}

/** Recover the session id and rollout name from a `session_meta` stdout line. */
function identityFromMetaLine(line: string): CodexIdentity | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; timestamp?: string; payload?: unknown }
    if (parsed.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object") {
      return null
    }
    const payload = parsed.payload as { id?: unknown; timestamp?: unknown }
    const sessionId = typeof payload.id === "string" ? payload.id : ""
    const timestampText = typeof payload.timestamp === "string"
      ? payload.timestamp
      : (typeof parsed.timestamp === "string" ? parsed.timestamp : "")
    if (!sessionId || !timestampText) return null

    const timestamp = new Date(timestampText)
    if (Number.isNaN(timestamp.getTime())) return null

    const fileName = descriptor.sessionFile.name(sessionId, timestamp)
    return { sessionId, fileName, filePath: join(sessionsRoot(), fileName) }
  } catch {
    return null
  }
}

interface LegacyArgs {
  permArgs: string[]
  modelArgs: string[]
  effortArgs: string[]
  /** Everything after the model and effort flags, prompt excluded. */
  turnArgs: string[]
  /** Positional prompt, or nothing when the message was images-only and empty. */
  promptArgs: string[]
}

function legacyArgs(
  req: StartSessionRequest | SendRequest,
  imagePaths: string[],
): LegacyArgs {
  const prompt = req.message || (imagePaths.length > 0 ? CODEX_IMAGE_ONLY_PROMPT : "")
  return {
    permArgs: descriptor.launchArgs.permissions(req.permissions),
    modelArgs: descriptor.launchArgs.model(req.model),
    effortArgs: descriptor.launchArgs.effort(req.effort),
    turnArgs: [
      ...descriptor.launchArgs.fastTier(req.fastMode),
      ...imagePaths.flatMap((filePath) => ["-i", filePath]),
    ],
    promptArgs: prompt ? [prompt] : [],
  }
}

function trackLegacySession(sessionId: string, session: PersistentSession): void {
  persistentSessions.set(sessionId, session)
  activeProcesses.set(sessionId, session.proc)
}

function newLegacySession(proc: ChildProcess, jsonlPath: string | null): PersistentSession {
  return { agentKind: "codex", proc, onResult: null, dead: false, jsonlPath }
}

/** Prefer the path the app-server reported; fall back to recognising the file. */
async function resolveStartedIdentity(
  thread: CodexThread,
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
): Promise<CodexIdentity> {
  const direct = getCodexThreadIdentity(thread)
  if (direct) return direct

  const discovered = await waitForNewSession(cwd, knownPaths, startedAt)
  if (discovered) return discovered
  throw new Error(`Codex created thread ${thread.id} but did not provide a rollout path`)
}

/**
 * Spawn `codex exec` and resolve once the session it created can be named.
 *
 * Two things race to identify it: the `session_meta` line on stdout, and the
 * filesystem scan. Whichever lands first wins, because older CLIs emit only one
 * of them.
 */
async function startLegacy(
  req: StartSessionRequest,
  knownPaths: Set<string>,
): Promise<StartedSession> {
  const imagePaths = await writeTempImageFiles(req.images)
  const args = legacyArgs(req, imagePaths)
  const startedAt = Date.now()

  const cli = resolveAgentCommand(descriptor.binName, [
    "exec",
    "--json",
    ...args.permArgs,
    ...args.modelArgs,
    ...args.effortArgs,
    ...args.turnArgs,
    ...args.promptArgs,
  ])
  const child = spawn(cli.command, cli.args, {
    cwd: req.cwd,
    // The session id only arrives once the CLI reports it, which is after the
    // env is fixed; the resume path below spawns with the real one.
    env: browserAgentEnv(process.env, NO_COGPIT_SESSION),
    stdio: ["ignore", "pipe", "pipe"],
    ...cli.spawnOptions,
  })

  const session = newLegacySession(child, null)
  let stderr = ""
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString() })

  return new Promise<StartedSession>((resolve, reject) => {
    let settled = false
    let sessionId: string | null = null
    const discovery = waitForNewSession(req.cwd, knownPaths, startedAt)
    const stdoutLines: string[] = []

    const succeed = async (identity: CodexIdentity, initialContent?: string) => {
      if (settled) return
      settled = true
      sessionId = identity.sessionId
      session.jsonlPath = identity.filePath
      if (!session.dead) trackLegacySession(identity.sessionId, session)

      let content = initialContent?.trim() ? initialContent : undefined
      if (!content) {
        try {
          content = await readFile(identity.filePath, "utf-8")
        } catch {
          // The client polls for it.
        }
      }
      resolve({
        sessionId: identity.sessionId,
        dirName: req.dirName,
        fileName: identity.fileName,
        filePath: identity.filePath,
        initialContent: content,
      })
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      reject(new AgentRuntimeError(500, "SPAWN_FAILED", message))
    }

    const reader = createInterface({ input: child.stdout! })
    reader.on("line", (line: string) => {
      if (stdoutLines.length < MAX_INITIAL_STDOUT_LINES) stdoutLines.push(line)
      if (settled) return
      const identity = identityFromMetaLine(line)
      if (identity) void succeed(identity, stdoutLines.join("\n"))
    })

    void discovery.then((match) => {
      if (!match) return
      if (sessionId === match.sessionId) session.jsonlPath = match.filePath
      void succeed(match)
    })

    child.on("close", async (code) => {
      session.dead = true
      await cleanupTempFiles(imagePaths)
      if (sessionId) {
        activeProcesses.delete(sessionId)
        persistentSessions.delete(sessionId)
      }
      if (settled) return
      if (code === 0) {
        const match = await discovery
        if (match) {
          await succeed(match)
          return
        }
      }
      fail(stderr.trim() || `${descriptor.binName} exited with code ${code}`)
    })

    child.on("error", async (error: NodeJS.ErrnoException) => {
      session.dead = true
      await cleanupTempFiles(imagePaths)
      fail(friendlySpawnError(error, "codex"))
    })
  })
}

/**
 * Resume a session through `codex exec resume`, reporting the turn's outcome on
 * the promise. The CLI has no result message, so the exit code is translated:
 * a signal kill is a user-requested stop, not a failure.
 */
async function sendLegacy(
  sessionId: string,
  req: SendRequest & { cwd: string },
): Promise<SendOutcome> {
  const imagePaths = await writeTempImageFiles(req.images)
  const args = legacyArgs(req, imagePaths)

  const cli = resolveAgentCommand(descriptor.binName, [
    "exec",
    ...args.permArgs,
    "resume",
    "--json",
    ...args.modelArgs,
    ...args.effortArgs,
    ...args.turnArgs,
    sessionId,
    ...args.promptArgs,
  ])
  const child = spawn(cli.command, cli.args, {
    cwd: req.cwd,
    env: browserAgentEnv(process.env, sessionId),
    stdio: ["ignore", "pipe", "pipe"],
    ...cli.spawnOptions,
  })

  const session = newLegacySession(child, req.filePath ?? null)
  trackLegacySession(sessionId, session)

  child.stdout?.on("data", () => {})
  let stderr = ""
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString() })

  const completion = new Promise<TurnResult>((resolve) => {
    session.onResult = (result) => {
      session.onResult = null
      resolve({
        isError: result.is_error === true,
        message: result.result,
      })
    }
  })

  const finish = async () => {
    await cleanupTempFiles(imagePaths)
    activeProcesses.delete(sessionId)
    persistentSessions.delete(sessionId)
  }

  child.on("close", async (code) => {
    session.dead = true
    await finish()
    // 143/137 are SIGTERM/SIGKILL: the user stopped the turn, which is not an
    // error to report back to them.
    const wasKilled = code === null || code === 143 || code === 137
    session.onResult?.({
      type: "result",
      subtype: wasKilled || code === 0 ? "success" : "error",
      is_error: !(wasKilled || code === 0),
      result: wasKilled || code === 0
        ? undefined
        : stderr.trim() || `${descriptor.binName} exited with code ${code}`,
    })
  })

  child.on("error", async (error: NodeJS.ErrnoException) => {
    session.dead = true
    await finish()
    session.onResult?.({
      type: "result",
      is_error: true,
      result: friendlySpawnError(error, "codex"),
    })
  })

  return { delivery: "started", completion }
}

// ── Approvals ───────────────────────────────────────────────────────────────

/**
 * Present a Codex approval as a tool call.
 *
 * The permission bar renders tool calls, and Codex asks about commands and file
 * writes rather than tools, so a plausible tool name is synthesised for each of
 * its two request kinds.
 */
export function normalizeCodexApproval(
  approval: CodexApproval,
  sessionId = approval.threadId,
): PendingApproval {
  const command = approval.kind === "commandExecution"
  const network = asRecord(approval.networkApprovalContext)
  const networkHost = network && typeof network.host === "string" ? network.host : null
  const networkProtocol = network && typeof network.protocol === "string"
    ? network.protocol.replace(/:$/, "")
    : "https"
  const networkPort = network && (typeof network.port === "number" || typeof network.port === "string")
    ? `:${String(network.port)}`
    : ""

  const input: Record<string, unknown> = {}
  if (command) {
    if (approval.command) input.command = approval.command
    if (approval.cwd) input.cwd = approval.cwd
    if (network) input.networkApprovalContext = network
    if (networkHost) input.url = `${networkProtocol}://${networkHost}${networkPort}`
    for (const field of [
      "commandActions",
      "additionalPermissions",
      "proposedExecpolicyAmendment",
      "proposedNetworkPolicyAmendments",
    ]) {
      if (approval.params[field] !== undefined) input[field] = approval.params[field]
    }
  } else {
    if (approval.grantRoot) input.file_path = approval.grantRoot
    if (approval.params.changes !== undefined) input.changes = approval.params.changes
  }
  if (approval.reason) input.reason = approval.reason

  const networkRequest = command && networkHost !== null
  return {
    sessionId,
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

function unavailableDecision(
  approval: CodexApproval,
  decision: ApprovalDecision,
): AgentRuntimeError {
  return new AgentRuntimeError(
    400,
    "CODEX_APPROVAL_DECISION_UNAVAILABLE",
    `Decision '${decision}' is not available for this approval request`,
    {
      requestId: String(approval.requestId),
      availableDecisions: approval.availableDecisions,
    },
  )
}

function approvalFailure(error: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    502,
    "CODEX_APPROVAL_FAILED",
    error instanceof Error ? error.message : "Failed to resolve Codex approval request",
  )
}

/**
 * Render answers as the message that carries them back to the thread.
 *
 * The question text is repeated only for a multi-question answer: alone it is
 * the message directly above, and quoting it back reads as an echo.
 */
function formatQuestionAnswer(
  pending: CodexAsyncQuestion,
  answers: UserQuestionAnswers,
): string {
  if (typeof answers === "string") return answers.trim()
  if (Array.isArray(answers)) return answers.join(", ").trim()

  const answered = pending.questions
    .map((question) => ({ question: question.question, answer: answers[question.question]?.trim() }))
    .filter((entry): entry is { question: string; answer: string } => Boolean(entry.answer))

  if (answered.length === 0) {
    return Object.values(answers).map((answer) => answer.trim()).filter(Boolean).join("\n\n")
  }
  return answered.length === 1
    ? answered[0].answer
    : answered.map(({ question, answer }) => `${question}\n${answer}`).join("\n\n")
}

// ── Runtime snapshot ────────────────────────────────────────────────────────

type RuntimeSection =
  | "account"
  | "usage"
  | "rateLimits"
  | "experimentalFeatures"
  | "permissionProfiles"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function bestEffort(promise: Promise<unknown>): Promise<{ value: unknown; error?: string }> {
  try {
    return { value: await promise }
  } catch (error) {
    return { value: null, error: errorMessage(error) }
  }
}

function readString(object: JsonObject, key: string): string | null {
  const value = object[key]
  return typeof value === "string" ? value : null
}

function runtimeVersion(initialize: InitializeResult): string | null {
  const explicit = readString(initialize, "version")
  if (explicit) return explicit
  const userAgent = readString(initialize, "userAgent")
  if (!userAgent) return null
  return (
    userAgent.match(/(?:codex(?:-cli|_cli_rs)?)[/ ]v?([\w.-]+)/i)?.[1]
    ?? userAgent.match(/^[^/\s]+\/v?([\w.-]+)/)?.[1]
    ?? userAgent
  )
}

async function describeCodexRuntime(): Promise<unknown> {
  let initialize: InitializeResult
  try {
    initialize = await codexAppServer.start()
  } catch (error) {
    return {
      available: false,
      version: null,
      userAgent: null,
      capabilities: null,
      account: null,
      usage: null,
      rateLimits: null,
      experimentalFeatures: null,
      permissionProfiles: null,
      errors: { runtime: errorMessage(error) },
    }
  }

  const sectionNames: RuntimeSection[] = [
    "account",
    "usage",
    "rateLimits",
    "experimentalFeatures",
    "permissionProfiles",
  ]
  const results = await Promise.all([
    bestEffort(codexAppServer.call("account/read", { refreshToken: false })),
    bestEffort(codexAppServer.call("account/usage/read")),
    bestEffort(codexAppServer.call("account/rateLimits/read")),
    bestEffort(codexAppServer.call("experimentalFeature/list", {})),
    bestEffort(codexAppServer.call("permissionProfile/list", {})),
  ])
  const sections: Record<RuntimeSection, unknown> = {
    account: null,
    usage: null,
    rateLimits: null,
    experimentalFeatures: null,
    permissionProfiles: null,
  }
  const errors: Partial<Record<RuntimeSection, string>> = {}
  results.forEach((result, index) => {
    const name = sectionNames[index]
    sections[name] = result.value
    if (result.error) errors[name] = result.error
  })

  return {
    available: true,
    version: runtimeVersion(initialize),
    userAgent: readString(initialize, "userAgent"),
    capabilities: {
      experimentalApi: CODEX_CLIENT_CAPABILITIES.experimentalApi,
      platformFamily: initialize.platformFamily ?? null,
      platformOs: initialize.platformOs ?? null,
      codexHome: initialize.codexHome ?? null,
    },
    ...sections,
    errors,
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const codexRuntime: AgentRuntime = {
  kind: "codex",
  descriptor,

  async start(req) {
    const knownPaths = new Set(
      (await storeFor("codex").listSessionFiles()).map((file) => file.filePath),
    )
    const startedAt = Date.now()
    try {
      const options = executionOptions(req)
      const started = await startCodexExecution(codexAppServer, options)
      const identity = await resolveStartedIdentity(
        started.thread,
        req.cwd,
        knownPaths,
        startedAt,
      )
      rememberThreadSettings(identity.sessionId, options)
      let initialContent: string | undefined
      try {
        initialContent = await readFile(identity.filePath, "utf-8")
      } catch {
        // The rollout can be materialized just after turn/start is accepted.
      }
      return {
        sessionId: identity.sessionId,
        dirName: req.dirName,
        fileName: identity.fileName,
        filePath: identity.filePath,
        initialContent,
      }
    } catch (error) {
      if (!isCodexAppServerUnavailable(error)) {
        throw new AgentRuntimeError(
          500,
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Failed to start Codex thread",
        )
      }
    }
    return startLegacy(req, knownPaths)
  },

  async send(sessionId, req) {
    const legacy = persistentSessions.get(sessionId)
    if (legacy && !legacy.dead) {
      // The pre-app-server CLI runs one turn per process and takes no input
      // while it does, so a concurrent send has nowhere to go.
      return { delivery: "busy" }
    }

    const cwd = await resolveSessionCwd(req.cwd, req.filePath)
    // Any message the thread receives is the answer to whatever it last asked,
    // whether it was typed into the question card or straight into the composer.
    codexQuestions.clear(sessionId)
    try {
      const options = executionOptions({ ...req, cwd })
      const result = await continueCodexExecution(codexAppServer, sessionId, options)
      rememberThreadSettings(sessionId, options)
      return { delivery: result.action, turnId: result.turnId }
    } catch (error) {
      if (!isCodexAppServerUnavailable(error)) {
        throw new AgentRuntimeError(
          500,
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Codex failed to accept the message",
        )
      }
    }
    return sendLegacy(sessionId, { ...req, cwd })
  },

  async interrupt(sessionId) {
    const turnId = codexAppServer.getActiveTurnId(sessionId)
    if (!turnId) return false
    await codexAppServer.interruptTurn(sessionId, turnId)
    return true
  },

  async stop(sessionId) {
    let stopped = false
    const turnId = codexAppServer.getActiveTurnId(sessionId)
    if (turnId) {
      try {
        await codexAppServer.interruptTurn(sessionId, turnId)
        stopped = true
      } catch {
        // Fall through to the legacy process controls: this keeps stop working
        // with older CLIs and across app-server restarts.
      }
    }
    return terminateTrackedSession(sessionId) || stopped
  },

  async stopAll() {
    // Turn-level, not session-level: interrupting leaves each thread resumable,
    // and the list includes sub-agent turns the parent thread does not own.
    const turns = codexAppServer.listActiveTurns()
    const results = await Promise.allSettled(
      turns.map(({ threadId, turnId }) => codexAppServer.interruptTurn(threadId, turnId)),
    )
    const stopped = results.filter((result) => result.status === "fulfilled").length
    return { stopped, failed: results.length - stopped }
  },

  async deleteSession(sessionId, filePath) {
    terminateTrackedSession(sessionId)
    await unlink(filePath)
    rememberedSettings.delete(sessionId)
  },

  activity(sessionId) {
    const active = codexAppServer.getActiveTurnId(sessionId) !== undefined
    const legacy = persistentSessions.get(sessionId)
    return {
      live: active || Boolean(legacy && !legacy.dead),
      running: active || activeProcesses.has(sessionId),
    }
  },

  hasSession(sessionId) {
    return codexAppServer.getActiveTurnId(sessionId) !== undefined
      || codexAppServer.listApprovalThreadIds().includes(sessionId)
      || persistentSessions.get(sessionId)?.agentKind === "codex"
  },

  listActive() {
    return codexAppServer
      .listActiveTurns()
      .map(({ threadId, turnId }) => ({ sessionId: threadId, turnId }))
  },

  listPendingApprovals(sessionId) {
    const threadIds = sessionId === undefined
      ? codexAppServer.listApprovalThreadIds()
      : [sessionId]
    return threadIds.flatMap((threadId) =>
      codexAppServer
        .listPendingApprovals(threadId)
        .map((approval) => normalizeCodexApproval(approval, threadId)),
    )
  },

  async respondToApproval(sessionId, requestId, decision) {
    const approval = codexAppServer
      .listPendingApprovals(sessionId)
      .find((candidate) => String(candidate.requestId) === requestId)
    if (!approval) return false
    if (!approval.availableDecisions.includes(decision)) {
      throw unavailableDecision(approval, decision)
    }
    try {
      await codexAppServer.respondApproval(approval, decision)
    } catch (error) {
      throw approvalFailure(error)
    }
    return true
  },

  async respondToAllApprovals(sessionId, decision) {
    const pending = codexAppServer.listPendingApprovals(sessionId)
    if (pending.length === 0) return { count: 0, toolNames: [] }

    // Validate the whole batch before answering any of it, so a request that
    // cannot take this decision fails the call instead of quietly getting a
    // different one.
    const planned = pending.map((approval) => {
      const chosen = selectAvailableDecision(approval.availableDecisions, decision)
      if (!chosen) throw unavailableDecision(approval, decision)
      return { approval, decision: chosen }
    })
    try {
      await Promise.all(
        planned.map(({ approval, decision: chosen }) =>
          codexAppServer.respondApproval(approval, chosen),
        ),
      )
    } catch (error) {
      throw approvalFailure(error)
    }
    return {
      count: pending.length,
      toolNames: [...new Set(pending.map((approval) => normalizeCodexApproval(approval).toolName))],
    }
  },

  listPendingQuestions(sessionId) {
    return codexQuestions.list(sessionId).map((question) => ({
      sessionId: question.threadId,
      toolUseId: question.itemId,
      askedAt: question.askedAt,
      questions: question.questions,
    }))
  },

  /**
   * Answering is sending a message: Codex's async questions carry no reply
   * channel of their own, and the thread reads the next message as the answer.
   * `send` steers a turn that is still running and starts one otherwise, which
   * is exactly the two cases a question can be answered in.
   */
  async answerQuestion(sessionId, questionId, answers) {
    const pending = codexQuestions
      .list(sessionId)
      .find((question) => question.itemId === questionId)
    if (!pending) return false

    const message = formatQuestionAnswer(pending, answers)
    if (!message) {
      throw new AgentRuntimeError(
        400,
        "INVALID_REQUEST",
        "answers must contain an answer to the pending question",
      )
    }

    await codexRuntime.send(sessionId, { ...rememberedSettings.get(sessionId), message })
    return true
  },

  listModels: fetchCodexModels,

  // token_count events are appended to the rollout live, so nothing is
  // outstanding while a turn runs.
  async liveUsageRecords() {
    return []
  },

  async fork() {
    throw new AgentRuntimeError(400, "FORK_UNSUPPORTED", "Sessions branch by copying the rollout")
  },

  describeRuntime() {
    return describeCodexRuntime()
  },

  shutdown() {
    rememberedSettings.clear()
    return codexAppServer.shutdown()
  },
}
