import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import {
  dirs,
  join,
  randomUUID,
  readFile,
  spawn,
  stat,
  unlink,
} from "../helpers"
import { browserAgentEnv } from "../browser/agentEnv"
import { claudeCliPath } from "./claudeExecutable"
import { fetchClaudeModels } from "./claudeModels"
import { friendlySpawnError } from "./spawnError"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { activeProcesses, terminateTrackedSession } from "../processRegistry"
import {
  attachSubagentWatcher,
  cleanupAllSDKSessions,
  createSDKSession,
  getSDKPermissions,
  getSDKUserQuestions,
  interruptSDKTurn,
  isSDKQueryLive,
  listUserQuestionSessionIds,
  resolveAllPermissions,
  resolvePermission,
  resolveUserQuestion,
  resumeSDKSession,
  sdkSessions,
  sendSDKMessage,
  stopSDKSession,
  type SDKSessionState,
} from "../sdk-session"
import { findJsonlPath } from "../sessionPaths"
import { resolveSessionCwd } from "./sessionCwd"
import { withTimeout } from "./timeout"
import {
  AgentRuntimeError,
  type AgentRuntime,
  type ApprovalDecision,
  type PendingApproval,
  type PendingQuestion,
  type SendOutcome,
  type SendRequest,
  type StartSessionRequest,
  type StartedSession,
  type TurnResult,
  type UserQuestionAnswers,
} from "./runtimeTypes"

/**
 * Claude Code, driven through the Anthropic Agent SDK in `../sdk-session`.
 *
 * Two spawn strategies survive here because the product has two: `/api/new-session`
 * runs the CLI once and waits for it to finish, while `/api/create-and-send`
 * opens a long-lived SDK query. `oneShot` on the request picks between them —
 * the other agents have a single strategy and ignore the flag.
 */

const descriptor = descriptorFor("claude")
const SPAWN_TIMEOUT_MS = 60_000
const TRANSCRIPT_POLL_ATTEMPTS = 150
const TRANSCRIPT_POLL_INTERVAL_MS = 100
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000
const CONTROL_TIMEOUT_MS = 20_000

function transcriptPath(dirName: string, sessionId: string): {
  fileName: string
  filePath: string
} {
  const fileName = descriptor.sessionFile.name(sessionId)
  return { fileName, filePath: join(dirs.PROJECTS_DIR, dirName, fileName) }
}

/**
 * Turn an SDK `result` message into the normalised outcome.
 *
 * A failure has to carry the agent's own text: the HTTP response for a resume
 * stays open until this settles precisely so the user sees why the turn failed
 * rather than a generic 500.
 */
function turnResultFrom(result: Record<string, unknown>): TurnResult {
  if (!result.is_error) return { isError: false }
  const { result: text, subtype } = result
  return {
    isError: true,
    message: text != null
      ? String(text)
      : `Claude returned an error${subtype ? ` (${subtype})` : ""}`,
  }
}

/** Wait for the SDK to materialise the transcript it names by session id. */
async function awaitTranscript(
  filePath: string,
  isSettled: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < TRANSCRIPT_POLL_ATTEMPTS; attempt++) {
    if (isSettled()) return false
    try {
      await stat(filePath)
      return true
    } catch {
      // Keep polling: the CLI writes the file a moment after it starts.
    }
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_POLL_INTERVAL_MS))
  }
  return false
}

/** Bind the sub-agent watcher as soon as the transcript path is known. */
function watchSubagentsFor(state: SDKSessionState, filePath: string | null): void {
  if (filePath) {
    state.jsonlPath = filePath
    attachSubagentWatcher(state)
    return
  }
  void findJsonlPath(state.sessionId).then((found) => {
    if (!found) return
    state.jsonlPath = found
    attachSubagentWatcher(state)
  })
}

/**
 * Run the CLI once and report the session only after it exits.
 *
 * The transcript is proof of work here: a run that exits without writing one
 * failed, however it exited, so the stat is what decides success.
 */
function startOneShot(req: StartSessionRequest): Promise<StartedSession> {
  const sessionId = randomUUID()
  const { fileName, filePath } = transcriptPath(req.dirName, sessionId)
  const cli = resolveAgentCommand(descriptor.binName, [
    "-p",
    req.message ?? "",
    "--session-id",
    sessionId,
    ...descriptor.launchArgs.permissions(req.permissions),
    ...descriptor.launchArgs.model(req.model),
    ...descriptor.launchArgs.effort(req.effort),
    ...(req.name ? ["--name", req.name] : []),
  ])

  // The CLI refuses to nest inside itself, and Cogpit is usually started from
  // a Claude session, so its marker has to go.
  const cleanEnv = browserAgentEnv({ ...process.env }, sessionId)
  delete cleanEnv.CLAUDECODE

  const child = spawn(cli.command, cli.args, {
    cwd: req.cwd,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    ...cli.spawnOptions,
  })

  let stderr = ""
  child.stdout?.on("data", () => {})
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString() })

  activeProcesses.set(sessionId, child)
  child.on("close", () => { activeProcesses.delete(sessionId) })

  return new Promise<StartedSession>((resolve, reject) => {
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new AgentRuntimeError(500, "SPAWN_FAILED", message))
    }

    const timer = setTimeout(() => {
      if (settled) return
      child.kill("SIGTERM")
      fail(stderr.trim() || "Timed out waiting for session to start")
    }, SPAWN_TIMEOUT_MS)

    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(friendlySpawnError(error, "claude"))
    })

    child.on("close", async (code) => {
      if (settled) return
      try {
        await stat(filePath)
        settled = true
        clearTimeout(timer)
        resolve({ sessionId, dirName: req.dirName, fileName, filePath })
      } catch {
        fail(
          stderr.trim()
          || `${descriptor.binName} exited with code ${code} before creating session`,
        )
      }
    })
  })
}

/** Open a long-lived SDK query and report as soon as its transcript exists. */
function startInteractive(req: StartSessionRequest): Promise<StartedSession> {
  const sessionId = randomUUID()
  const { fileName, filePath } = transcriptPath(req.dirName, sessionId)

  const state = createSDKSession({
    sessionId,
    // An images-only send has no prompt; the SDK substitutes its own
    // "See the attached image(s)." for a falsy one either way.
    message: req.message ?? "",
    cwd: req.cwd,
    images: req.images,
    permissionMode: req.permissions?.mode,
    allowedTools: req.permissions?.allowedTools,
    disallowedTools: req.permissions?.disallowedTools,
    model: req.model,
    effort: req.effort,
    fastMode: req.fastMode,
    ultracode: !!req.ultracode,
    name: req.name,
    worktreeName: req.worktreeName,
    mcpConfig: req.mcpConfig,
  })

  return new Promise<StartedSession>((resolve, reject) => {
    let settled = false
    const succeed = async () => {
      if (settled) return
      settled = true
      let initialContent: string | undefined
      try {
        initialContent = await readFile(filePath, "utf-8")
      } catch {
        // The client polls for it; an unreadable file is not a failed spawn.
      }
      resolve({ sessionId, dirName: req.dirName, fileName, filePath, initialContent })
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      reject(new AgentRuntimeError(500, "SPAWN_FAILED", message))
    }

    void awaitTranscript(filePath, () => settled).then((exists) => {
      if (!exists) return
      watchSubagentsFor(state, filePath)
      void succeed()
    })

    state.onResult = (result) => {
      state.onResult = null
      const outcome = turnResultFrom(result)
      if (outcome.isError) fail(outcome.message ?? "Claude returned an error")
      else void succeed()
      if (!state.jsonlPath) watchSubagentsFor(state, null)
    }
  })
}

// ── Runtime snapshot ────────────────────────────────────────────────────────

interface ClaudeRuntimeSnapshot {
  available: true
  account: unknown
  usage: unknown
  models: unknown[]
  agents: unknown[]
  fetchedAt: number
}

let cachedSnapshot: ClaudeRuntimeSnapshot | null = null
let snapshotInFlight: Promise<ClaudeRuntimeSnapshot> | null = null

async function bestEffort<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

/**
 * Read account and plan usage through the SDK's authenticated control channel.
 *
 * There is no persistent connection to ask, so one is opened around the call:
 * a query whose prompt never yields, kept alive only long enough to issue
 * control requests. This avoids reading OAuth secrets out of the Keychain and
 * works on every platform the SDK supports.
 */
async function describeClaudeRuntime(force = false): Promise<ClaudeRuntimeSnapshot> {
  if (!force && cachedSnapshot && Date.now() - cachedSnapshot.fetchedAt < RUNTIME_CACHE_TTL_MS) {
    return cachedSnapshot
  }
  if (snapshotInFlight) return snapshotInFlight

  snapshotInFlight = (async () => {
    const abort = new AbortController()
    const control = query({
      // eslint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise(() => {})
      })(),
      options: {
        abortController: abort,
        maxTurns: 1,
        pathToClaudeCodeExecutable: claudeCliPath(),
      },
    })

    try {
      const [account, usage, models, agents] = await withTimeout(
        Promise.all([
          bestEffort(control.accountInfo()),
          bestEffort(control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
          bestEffort(control.supportedModels()),
          bestEffort(control.supportedAgents()),
        ]),
        CONTROL_TIMEOUT_MS,
        "claude runtime",
      )
      cachedSnapshot = {
        available: true,
        account,
        usage,
        models: models ?? [],
        agents: agents ?? [],
        fetchedAt: Date.now(),
      }
      return cachedSnapshot
    } finally {
      abort.abort()
      control.close()
    }
  })()

  try {
    return await snapshotInFlight
  } finally {
    snapshotInFlight = null
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const claudeRuntime: AgentRuntime = {
  kind: "claude",
  descriptor,

  start(req) {
    return req.oneShot ? startOneShot(req) : startInteractive(req)
  },

  async send(sessionId, req: SendRequest): Promise<SendOutcome> {
    const live = sdkSessions.get(sessionId)
    if (isSDKQueryLive(live)) {
      // The query is alive: put the message on its input stream and let the
      // frontend watch the transcript. A turn result can arrive while
      // background work is still running, so `running` is not a liveness test.
      const state = sendSDKMessage(sessionId, req.message ?? "", req.images, {
        model: req.model,
        effort: req.effort,
        fastMode: req.fastMode,
        ultracode: req.ultracode,
        mcpConfig: req.mcpConfig,
      })
      if (!state) {
        throw new AgentRuntimeError(
          500,
          "INTERNAL_ERROR",
          "Failed to send message to running session",
        )
      }
      return { delivery: "enqueued" }
    }

    const state = resumeSDKSession({
      sessionId,
      cwd: await resolveSessionCwd(req.cwd, req.filePath),
      message: req.message ?? "",
      images: req.images,
      permissionMode: req.permissions?.mode,
      allowedTools: req.permissions?.allowedTools,
      disallowedTools: req.permissions?.disallowedTools,
      model: req.model,
      effort: req.effort,
      fastMode: req.fastMode,
      ultracode: req.ultracode,
      mcpConfig: req.mcpConfig,
    })
    watchSubagentsFor(state, req.filePath ?? null)

    // A resume reports its outcome on this request and nowhere else, so the
    // caller holds the HTTP response open until the turn finishes.
    const completion = new Promise<TurnResult>((resolve) => {
      state.onResult = (result) => {
        state.onResult = null
        resolve(turnResultFrom(result))
      }
    })
    return { delivery: "started", completion }
  },

  interrupt(sessionId) {
    return interruptSDKTurn(sessionId)
  },

  async stop(sessionId) {
    const stoppedQuery = stopSDKSession(sessionId)
    const stoppedProcess = terminateTrackedSession(sessionId)
    return stoppedQuery || stoppedProcess
  },

  async stopAll() {
    return { stopped: cleanupAllSDKSessions(), failed: 0 }
  },

  async deleteSession(sessionId, filePath) {
    terminateTrackedSession(sessionId)
    await unlink(filePath)
  },

  activity(sessionId) {
    const state = sdkSessions.get(sessionId)
    return {
      live: isSDKQueryLive(state),
      running: state?.running === true || activeProcesses.has(sessionId),
    }
  },

  hasSession(sessionId) {
    return sdkSessions.has(sessionId)
  },

  listActive() {
    const active: Array<{ sessionId: string }> = []
    for (const [sessionId, state] of sdkSessions) {
      if (isSDKQueryLive(state)) active.push({ sessionId })
    }
    return active
  },

  listPendingApprovals(sessionId): PendingApproval[] {
    const ids = sessionId === undefined ? [...sdkSessions.keys()] : [sessionId]
    return ids.flatMap((id) => getSDKPermissions(id).map((request) => ({
      ...request,
      sessionId: id,
      // The SDK parks every request on the same callback, so all three
      // decisions are always answerable.
      availableDecisions: ["allow", "allow_always", "deny"] as ApprovalDecision[],
    })))
  },

  async respondToApproval(sessionId, requestId, decision) {
    return resolvePermission(sessionId, requestId, decision).found
  },

  async respondToAllApprovals(sessionId, decision) {
    // Every pending callback resolves in one pass: they are all parked in the
    // same map, so there is no window for a new one to arrive mid-batch.
    const toolNames = resolveAllPermissions(sessionId, decision)
    return { count: toolNames.length, toolNames }
  },

  listPendingQuestions(sessionId): PendingQuestion[] {
    const ids = sessionId === undefined ? listUserQuestionSessionIds() : [sessionId]
    return ids.flatMap((id) => getSDKUserQuestions(id))
  },

  async answerQuestion(sessionId, questionId, answers: UserQuestionAnswers) {
    return resolveUserQuestion(sessionId, questionId, answers).found
  },

  listModels: fetchClaudeModels,

  // Usage is written to the transcript as the turn runs, so an open session is
  // already fully on disk.
  async liveUsageRecords() {
    return []
  },

  async fork() {
    throw new AgentRuntimeError(400, "FORK_UNSUPPORTED", "Sessions branch by copying the transcript")
  },

  describeRuntime(force) {
    return describeClaudeRuntime(force)
  },

  async shutdown() {
    // The SDK owns no transport of its own: its children live in the shared
    // process registry, which the composition roots tear down separately.
  },
}
