import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  Options,
  SDKMessage,
  SDKSessionWritesLostMessage,
  SDKUserMessage,
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  McpServerConfig,
  OnElicitation,
  OnUserDialog,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
  Query,
  UserDialogRequest,
  UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import type { PermissionRequest } from "../shared/contracts/permissions"
import type { QuestionUnanswered } from "../shared/contracts/pendingInput"
import { presentTurnError } from "../shared/session/agent-errors"
import { watchSubagents, type SubagentTask, type SubagentWatcher } from "./subagentWatcher"
import { claudeLaunchOptions } from "./agents/claudeExecutable"
import { appendToSystemPrompt, withControlQuery } from "./agents/sdk"
import { pluginSkillContext } from "./plugins/skillContext"
import { readSdkRateLimit } from "./agents/rateLimit"
import { logAgentFailure } from "./agents/failureLog"
import { describeStartupFailure } from "./agents/startupFailures"
import type { UserQuestionAnswers } from "./agents/runtimeTypes"
import { BROWSER_CONTEXT_APPEND, BROWSER_HOOK_TOOL, browserPreToolUseHook } from "./browser/agentContext"
import { MEDIA_CONTEXT_APPEND } from "./agents/replyContext"
import { cogpitAgentEnv, browserShimInstalled } from "./browser/agentEnv"
import * as streamBus from "./lib/streamBus"
import { sessionConfigKey, updateSessionConfig } from "./lib/sessionConfigStore"
import { projectElicitationSchema } from "./lib/elicitationSchema"
import { asRecord } from "../shared/objects"
import type {
  MissionControlQuestion,
  MissionControlQuestionItem,
} from "../shared/contracts/missionControl"
import type {
  ElicitationAction,
  ElicitationContent,
  MissionControlElicitation,
  MissionControlElicitationField,
  MissionControlUserDialog,
  UserDialogChoice,
} from "../shared/contracts/agentPrompts"

/**
 * Parse COGPIT_STREAM_PARTIAL as an opt-out kill switch. Streaming stays on
 * unless the value is 0, false, off, or no (case-insensitive and trimmed).
 */
function streamingEnabled(): boolean {
  const raw = process.env.COGPIT_STREAM_PARTIAL
  if (raw === undefined) return true
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase())
}

/** @internal test-only alias */
export const streamingEnabledForTest = streamingEnabled

// ── Types ────────────────────────────────────────────────────────────────

export interface PermissionRequestData extends Omit<PermissionRequest, "suggestions" | "availableDecisions"> {
  suggestions?: PermissionUpdate[]
  suppressAlwaysAllowRule?: boolean
}

interface PendingPermission extends PermissionRequestData {
  /** The user's own ask rule that forced this ask: a person answers it, never a mode switch. */
  matchedAskRule?: Parameters<CanUseTool>[2]["matchedAskRule"]
  resolve: (result: PermissionResult) => void
}

/** A pending ask as the dashboard sees it. */
function permissionRequestOf({ resolve: _, matchedAskRule: _rule, ...request }: PendingPermission): PermissionRequestData {
  return request
}

interface PendingUserQuestion {
  input: Record<string, unknown>
  /** When the agent asked — lets a dashboard show how long it has been stuck. */
  askedAt: number
  resolve: (result: PermissionResult) => void
}

interface PendingElicitation {
  request: ElicitationRequest
  /** Rendered form fields, projected once at park time. */
  fields: MissionControlElicitationField[]
  askedAt: number
  resolve: (result: ElicitationResult) => void
}

interface PendingUserDialog {
  dialog: Omit<MissionControlUserDialog, "sessionId">
  resolve: (result: UserDialogResult) => void
}

export type PermissionDecision = "allow" | "allow_always" | "deny"

export type ImageAttachment = { data: string; mediaType: string }

export interface SDKSessionState {
  pluginSkillLoading?: boolean
  sessionId: string
  cwd: string
  /** Permission requests awaiting user decision — canUseTool is blocked on the `resolve` promise */
  pendingPermissions: Map<string, PendingPermission>
  /** AskUserQuestion requests awaiting an answers object from the dashboard. */
  pendingUserQuestions: Map<string, PendingUserQuestion>
  /** MCP elicitations awaiting an answer, keyed by control-request id. */
  pendingElicitations: Map<string, PendingElicitation>
  /** CLI dialogs awaiting a choice, keyed by control-request id. */
  pendingUserDialogs: Map<string, PendingUserDialog>
  running: boolean
  /**
   * Background agents and workflows the CLI process reports live, by task id.
   * The CLI sends the whole set on every change and nothing at startup, so it
   * is replaced, never patched, and starts empty with each process.
   */
  backgroundAgents: ReadonlySet<string>
  abort: AbortController | null
  /** The live SDK Query handle. It stays alive across turn results while its input queue is open. */
  activeQuery: Query | null
  /** Persistent streaming-input queue used to add turns without resuming a competing query. */
  messageStream: {
    enqueue: (message: SDKUserMessage) => boolean
    close: () => void
  } | null
  onResult: ((msg: Record<string, unknown>) => void) | null
  onInit: (() => void) | null
  jsonlPath: string | null
  /** Subagents the CLI reported starting, by task id (= transcript file id). */
  subagentTasks: Map<string, SubagentTask>
  /** Watches sub-agent JSONL files and synthesizes progress into parent JSONL */
  subagentWatcher: SubagentWatcher | null
  /**
   * The mode the CLI runs in, as far as it has said (system/init and
   * system/status), or the one the next process starts with.
   */
  permissionMode: string
  /** Protocol capabilities the running CLI listed in system/init. */
  capabilities: ReadonlySet<string>
  /**
   * Servers the running process got in its `mcpServers` launch option that no
   * setMcpServers call has named yet. The CLI keeps such a server connected
   * when a later call leaves it out.
   */
  launchMcpServers: Record<string, McpServerConfig> | null
  allowedTools: string[]
  disallowedTools: string[]
  model?: string
  effort?: string
  /** Fast is a session setting, independent from reasoning effort. */
  fastMode?: boolean
  /** Ultracode: standing dynamic-workflow orchestration for the session, at
   *  whatever effort is selected. Set at launch via the SDK `settings` option
   *  (the --settings path), which also ensures Workflows are enabled. */
  ultracode?: boolean
  mcpConfig?: string | null
  /** stderr captured from the Claude CLI subprocess for the current run —
   *  surfaced in the error result so failures show the real reason (e.g. a
   *  missing native binary or glibc mismatch) instead of "exited with code 1". */
  stderr?: string
}

export const sdkSessions = new Map<string, SDKSessionState>()

const NO_BACKGROUND_AGENTS: ReadonlySet<string> = new Set()
const NO_CAPABILITIES: ReadonlySet<string> = new Set()

/**
 * Task types that are agents working for the session. Shells, monitors and MCP
 * calls also outlive a turn, but a dev server left running is not the session
 * still working; an unknown type is left out so it can never pin a session busy.
 */
const BACKGROUND_AGENT_TASK_TYPES = new Set(["local_agent", "local_workflow", "remote_agent"])
/**
 * The sends written to a query, by uuid. `taken` holds the ones the CLI reports
 * it took up (`command_lifecycle`); it stays null on a CLI that reports none.
 */
interface InputTurns { sent: string[]; completed: number; taken: Set<string> | null }
const inputTurns = new WeakMap<SDKSessionState, InputTurns>()
const resultObservers = new WeakMap<SDKSessionState, Set<{ turn: number; resolve: (result: Record<string, unknown>) => void }>>()
export function observeSDKResult(state: SDKSessionState) {
  let observer!: { turn: number; resolve: (result: Record<string, unknown>) => void }
  const turn = (inputTurns.get(state)?.sent.length ?? Number(state.running)) + 1
  const completion = new Promise<Record<string, unknown>>((resolve) => { observer = { turn, resolve } })
  const observers = resultObservers.get(state) ?? new Set()
  observers.add(observer); resultObservers.set(state, observers)
  return { completion, cancel: () => { observers.delete(observer); observer.resolve({ is_error: true, result: "Message was not accepted" }) } }
}
/** Whether a turn is still owed an answer: a caller waits on it, or it was mid-flight. */
function hasUnfinishedWork(state: SDKSessionState): boolean {
  return state.onResult !== null || (resultObservers.get(state)?.size ?? 0) > 0 || state.running
}

function logTurnFailure(state: SDKSessionState, result: Record<string, unknown>): void {
  const httpStatus = typeof result.api_error_status === "number" ? result.api_error_status : undefined
  logAgentFailure("turn", { sessionId: state.sessionId, kind: "claude", message: describeErrorResult(result), httpStatus })
}

function notifyResultObservers(state: SDKSessionState, result: Record<string, unknown>, end = false) {
  const turns = inputTurns.get(state)
  // A send that joins a running turn gets no result of its own, so a result
  // settles every send the CLI has taken up. A CLI without lifecycle reports
  // only says how many it still holds queued.
  const queued = result.queued_turn_count
  if (turns && !end && !turns.taken) turns.completed = typeof queued === "number" ? Math.max(turns.completed, turns.sent.length - queued) : turns.completed + 1
  const settled = (turn: number) => turns?.taken ? turns.taken.has(turns.sent[turn - 1]) : turn <= (turns?.completed ?? 0)
  const observers = resultObservers.get(state)
  for (const observer of observers ?? []) {
    if (!end && !settled(observer.turn)) continue
    observers!.delete(observer); observer.resolve(result)
  }
  if (!observers?.size) resultObservers.delete(state)
}

// ── Attach the sub-agent file watcher once the JSONL path is known ──

export function attachSubagentWatcher(state: SDKSessionState): void {
  // A path lookup can finish after a short query has already completed. Never
  // attach a permanent poller to an idle session in that race.
  if (state.subagentWatcher || !state.jsonlPath || !state.activeQuery) return
  state.subagentWatcher = watchSubagents(
    state.jsonlPath,
    state.sessionId,
    state.subagentTasks,
  )
}

// ── canUseTool: block until the user resolves the request ───────────────

function makeCanUseTool(state: SDKSessionState): CanUseTool {
  return (toolName, input, options) => {
    // AskUserQuestion is a tool invocation, not a permission request. The SDK
    // waits for this callback before it can produce the tool result, so a
    // normal follow-up message cannot answer it. Keep its resolver separate
    // from the permission bar and complete it through resolveUserQuestion().
    if (toolName === "AskUserQuestion") {
      const toolUseId = options.toolUseID
      return new Promise<PermissionResult>((resolve) => {
        const pending: PendingUserQuestion = {
          input,
          askedAt: Date.now(),
          resolve,
        }
        state.pendingUserQuestions.set(toolUseId, pending)

        const onAbort = () => {
          if (state.pendingUserQuestions.delete(toolUseId)) {
            resolve({ behavior: "deny", message: "Session aborted", interrupt: true })
          }
        }
        options.signal?.addEventListener("abort", onAbort, { once: true })
      })
    }

    // The CLI asks only when it wants a person, whatever the mode: even under
    // bypassPermissions some calls ask, and the MCP sign-in confirmation always
    // does. Every ask reaches the approval bar.
    const requestId = options.toolUseID

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        toolName,
        input,
        toolUseId: options.toolUseID,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        suggestions: options.suggestions,
        defaultToNo: options.defaultToNo,
        suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
        matchedAskRule: options.matchedAskRule,
        timestamp: Date.now(),
        resolve,
      }
      state.pendingPermissions.set(requestId, pending)

      const onAbort = () => {
        if (state.pendingPermissions.delete(requestId)) {
          resolve({ behavior: "deny", message: "Session aborted", interrupt: true })
        }
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

// ── onElicitation: MCP servers asking the user for input ─────────────

function makeOnElicitation(state: SDKSessionState): OnElicitation {
  return (request, options) => {
    // URL mode carries a link rather than a schema; anything else is a form.
    const projection = request.mode === "url"
      ? { fields: [] as MissionControlElicitationField[] }
      : projectElicitationSchema(asRecord(request.requestedSchema) ?? undefined)

    if ("unsupported" in projection) {
      streamBus.publishError(
        state.sessionId,
        `Declined an input request from MCP server "${request.serverName}": Cogpit `
        + `renders text, number, checkbox and choice fields only, and `
        + `${projection.unsupported}.`,
      )
      return Promise.resolve<ElicitationResult>({ action: "decline" })
    }

    return new Promise<ElicitationResult>((resolve) => {
      const requestId = options.requestId
      state.pendingElicitations.set(requestId, {
        request,
        fields: projection.fields,
        askedAt: Date.now(),
        resolve,
      })

      const onAbort = () => {
        if (state.pendingElicitations.delete(requestId)) resolve({ action: "decline" })
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

// ── onUserDialog: blocking dialogs the CLI asks the host to render ────

const REFUSAL_FALLBACK_DIALOG = "refusal_fallback_prompt"

/**
 * Dialog kinds Cogpit declares, with the choices each one accepts.
 *
 * The CLI fails closed: a kind that is not declared here is never emitted and
 * its flow degrades to the no-dialog behaviour (for the refusal fallback, the
 * classic refusal error ends the turn). Declaring a kind Cogpit cannot draw is
 * worse than omitting it — real dialogs would then be routed to a surface that
 * drops them.
 */
const DIALOG_CHOICES: Record<string, ReadonlySet<string>> = {
  [REFUSAL_FALLBACK_DIALOG]: new Set(["retry_fallback", "edit_prompt", "cancelled"]),
}

export const SUPPORTED_DIALOG_KINDS = [REFUSAL_FALLBACK_DIALOG] as const

function projectUserDialog(
  request: UserDialogRequest,
): Omit<MissionControlUserDialog, "sessionId" | "requestId" | "askedAt"> | null {
  if (request.dialogKind !== REFUSAL_FALLBACK_DIALOG) return null
  const payload = asRecord(request.payload) ?? {}
  const originalModel = payload.originalModel
  const fallbackModel = payload.fallbackModel
  if (typeof originalModel !== "string" || typeof fallbackModel !== "string") return null
  return {
    dialogKind: REFUSAL_FALLBACK_DIALOG,
    originalModel,
    fallbackModel,
    ...(typeof payload.guidanceText === "string" && payload.guidanceText
      ? { guidanceText: payload.guidanceText }
      : {}),
  }
}

function makeOnUserDialog(state: SDKSessionState): OnUserDialog {
  return (request, options) => {
    // A kind Cogpit never declared is not Cogpit's to settle: on a multi-client
    // session the request reaches every attached client, and "cancelled" is a
    // real settlement the CLI reads as the user dismissing the dialog — it
    // would dismiss the dialog out from under whichever client does render it.
    // Sending no answer leaves it for that client; the CLI cancels it at its
    // own deadline if nobody answers.
    if (!(request.dialogKind in DIALOG_CHOICES)) return Promise.resolve(null)

    // A declared kind Cogpit cannot read IS Cogpit's to settle: cancelling
    // makes the CLI apply that dialog's default instead of parking until the
    // deadline.
    const projected = projectUserDialog(request)
    if (!projected) return Promise.resolve<UserDialogResult>({ behavior: "cancelled" })

    return new Promise<UserDialogResult>((resolve) => {
      const requestId = options.requestId
      state.pendingUserDialogs.set(requestId, {
        dialog: { ...projected, requestId, askedAt: Date.now() },
        resolve,
      })

      const onAbort = () => {
        if (state.pendingUserDialogs.delete(requestId)) resolve({ behavior: "cancelled" })
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

// ── Build SDK query options ──────────────────────────────────────────

/** The servers an MCP selection names, or null when it names none or is not valid JSON. */
function parseMcpServers(mcpConfig: string | null | undefined): Record<string, McpServerConfig> | null {
  if (!mcpConfig) return null
  try {
    const parsed = asRecord(JSON.parse(mcpConfig))
    return parsed && Object.keys(parsed).length > 0 ? parsed as Record<string, McpServerConfig> : null
  } catch {
    return null
  }
}

/** The CLI refuses to start able to skip permissions as root, outside a sandbox. */
function canSkipPermissions(): boolean {
  return process.getuid?.() !== 0 || Boolean(process.env.IS_SANDBOX)
}

function buildQueryOptions(state: SDKSessionState, opts: {
  isResume?: boolean
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
}): Options {
  const queryOpts: Options = {
    abortController: state.abort!,
    cwd: state.cwd,
    model: state.model,
    permissionMode: (state.permissionMode || "default") as PermissionMode,
    allowedTools: state.allowedTools.length > 0 ? state.allowedTools : undefined,
    disallowedTools: state.disallowedTools.length > 0 ? state.disallowedTools : undefined,
    // Always registered, even in bypassPermissions: AskUserQuestion can only
    // deliver answers through this callback. Without it the CLI errors the
    // tool instantly ("Answer questions?") and the dashboard shows a dead
    // question bar that swallows input.
    canUseTool: makeCanUseTool(state),
    // Without this the SDK declines every MCP elicitation automatically, so a
    // server asking for a token or a browser login fails with no trace.
    onElicitation: makeOnElicitation(state),
    onUserDialog: makeOnUserDialog(state),
    supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS],
    effort: state.effort as Options["effort"],
    enableFileCheckpointing: true,
    persistSession: true,
    ...claudeLaunchOptions(),
    // Token-level streaming: raw Anthropic stream events are forwarded to
    // the stream bus so the UI can render text as it is generated.
    includePartialMessages: streamingEnabled(),
    // Forward the full subagent conversation (tagged with parent_tool_use_id)
    // so live subagent transcripts can render under their tool card.
    forwardSubagentText: true,
    // Fork a running subagent every ~30s for a one-line "what am I doing now",
    // delivered on task_progress. Reuses the subagent's model and prompt cache.
    agentProgressSummaries: true,
    // One predicted next prompt per turn, delivered after `result`. The query
    // iterator below keeps running past `result`, which is what makes it
    // reachable at all.
    promptSuggestions: true,
  }

  // Every session can be switched to bypass later, not only one that starts there.
  if (canSkipPermissions()) queryOpts.allowDangerouslySkipPermissions = true

  if (opts.isResume) {
    queryOpts.resume = state.sessionId
  } else {
    queryOpts.sessionId = state.sessionId
  }

  const extraArgs: Record<string, string | null> = {}
  if (opts.name) extraArgs.name = opts.name
  if (opts.worktreeName) extraArgs.worktree = opts.worktreeName
  if (Object.keys(extraArgs).length > 0) queryOpts.extraArgs = extraArgs

  const mcpServers = parseMcpServers(opts.mcpConfig)
  if (mcpServers) queryOpts.mcpServers = mcpServers

  // The `settings` layer (the --settings equivalent) outranks the user's own
  // settings. A full session refuses every message, including the ones agents
  // send each other, so sessions run here always compact near the limit.
  // Ultracode needs Workflows enabled to function.
  queryOpts.settings = {
    autoCompactEnabled: true,
    ...(state.ultracode ? { ultracode: true, enableWorkflows: true } : {}),
    ...(state.fastMode ? { fastMode: true } : {}),
  }

  queryOpts.env = cogpitAgentEnv({ ...process.env }, state.sessionId)
  delete queryOpts.env.CLAUDECODE
  queryOpts.systemPrompt = appendToSystemPrompt(queryOpts.systemPrompt, MEDIA_CONTEXT_APPEND)

  // A skill is only read if the agent decides to read it, so the panel and the
  // subagent throwaway rule also arrive as context it cannot skip and a hook it
  // cannot ignore. Both cost nothing to a machine without agent-browser, so
  // neither is registered there.
  if (browserShimInstalled()) {
    queryOpts.systemPrompt = appendToSystemPrompt(queryOpts.systemPrompt, BROWSER_CONTEXT_APPEND)
    queryOpts.hooks = {
      ...queryOpts.hooks,
      PreToolUse: [
        ...(queryOpts.hooks?.PreToolUse ?? []),
        { matcher: BROWSER_HOOK_TOOL, hooks: [browserPreToolUseHook] },
      ],
    }
  }

  // Capture the CLI subprocess's stderr so a spawn/exit failure carries its
  // real cause into the error result. Capped to avoid unbounded growth.
  queryOpts.stderr = (data: string) => {
    const next = (state.stderr || "") + data
    state.stderr = next.length > 16_000 ? next.slice(-16_000) : next
  }

  return queryOpts
}

// ── Process SDK events ───────────────────────────────────────────────

/** Human-readable text for an errored `result` message. */
export function describeErrorResult(result: Record<string, unknown>): string {
  if (result.result != null) return presentTurnError(String(result.result))
  // Error results carry no `result` text; the cause, a startup failure's
  // stderr included, is listed in `errors`.
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((error): error is string => typeof error === "string" && error.trim() !== "")
    : []
  if (errors.length > 0) {
    const detail = presentTurnError(errors.join("\n"))
    return describeStartupFailure(result, detail) ?? detail
  }
  const subtype = result.subtype
  return `Claude returned an error${subtype ? ` (${String(subtype)})` : ""}`
}

/**
 * Follow the mode the CLI says it runs in, which can differ from the one asked
 * for: a session started without one runs in bypassPermissions, auto mode
 * starts in Manual where it is unavailable, and approving a plan moves a
 * session on. The stored config follows, whatever a client stored there
 * before, and every client showing the session reads it again.
 */
function adoptPermissionMode(state: SDKSessionState, mode: string | undefined): void {
  if (!mode) return
  state.permissionMode = mode
  const { sessionId } = state
  void updateSessionConfig(sessionConfigKey(sessionId), () => ({ permissionMode: mode }))
    .then(({ changed }) => { if (changed.length > 0) streamBus.publishSessionConfig(sessionId) }, () => {})
}

/** How long before a sign-in ends its sessions warn about it. The CLI's date can be up to 3 days late. */
export const SIGN_IN_WARNING_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Tell the session's viewers, with each turn's result, when its sign-in ends
 * soon, or that it does not. A credential without a known end says nothing.
 */
function reportSignInEnd(sessionId: string, expiresAt: string | undefined): void {
  const end = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (!Number.isFinite(end)) return
  streamBus.publishSignInEnd(sessionId, end - Date.now() < SIGN_IN_WARNING_MS ? new Date(end).toISOString() : null)
}

/** What a full disk cost the session, from the CLI's `session_writes_lost` notice. */
export function describeWritesLost(msg: Pick<SDKSessionWritesLostMessage, "error_code" | "lost">): string {
  const cause = msg.error_code === "EDQUOT" ? "The disk quota is used up" : "The disk is full"
  const lost = [
    msg.lost.includes("transcript") && "part of this session's transcript",
    msg.lost.includes("global_config") && "changes to the CLI's global settings file",
  ].filter(Boolean).join(" and ")
  const consequence = msg.lost.includes("transcript") ? " Resuming the session may miss part of the conversation." : ""
  return `${cause}, so ${lost || "some of what the session wrote"} could not be saved.${consequence} Free some space before you continue.`
}

function processSDKEvent(state: SDKSessionState, msg: SDKMessage): void {
  const lifecycle = msg as unknown as { type: string; command_uuid?: string; state?: string }
  if (lifecycle.type === "command_lifecycle") {
    const turns = inputTurns.get(state)
    if (turns) {
      turns.taken ??= new Set()
      if (lifecycle.command_uuid && lifecycle.state !== "queued") turns.taken.add(lifecycle.command_uuid)
    }
  }
  // The CLI starts some turns itself, after a background task finishes or with the notice it
  // injects on resume about agents a stopped process lost. Their output is the only sign.
  if (!state.running && (msg.type === "assistant" || msg.type === "stream_event") && msg.parent_tool_use_id === null) state.running = true
  if (msg.type === "system" && msg.subtype === "init") {
    state.cwd = msg.cwd
    state.capabilities = new Set(msg.capabilities ?? [])
    adoptPermissionMode(state, msg.permissionMode)
    const onInit = state.onInit
    state.onInit = null
    onInit?.()
  }
  if (msg.type === "result") {
    // A result is a turn boundary, not necessarily the end of the SDK query.
    // Background agents/workflows can outlive it, and the persistent input
    // stream remains available for queued follow-up turns. A send the CLI
    // still holds queued runs as the next turn straight away.
    state.running = (msg.queued_turn_count ?? 0) > 0
    streamBus.clear(state.sessionId)
    reportSignInEnd(state.sessionId, msg.credential_expires_at)
    const result = msg as unknown as Record<string, unknown>
    if (result.is_error) logTurnFailure(state, result)
    notifyResultObservers(state, result)
    if (state.onResult) {
      state.onResult(result)
      state.onResult = null
    } else if (result.is_error) {
      // Nobody is holding an HTTP response for this turn (the enqueue path
      // answers 200 immediately), so push the failure to the client instead of
      // letting the turn stop with no explanation.
      streamBus.publishError(state.sessionId, describeErrorResult(result))
    }
  }

  if (msg.type === "prompt_suggestion") {
    // Arrives after `result`, so the bus session was cleared just above. The
    // clear only tears the session down when nothing is subscribed, so a
    // watching client still gets this; an unwatched one drops it, correctly.
    const suggestion = (msg as unknown as { suggestion?: unknown }).suggestion
    if (typeof suggestion === "string" && suggestion.trim()) {
      streamBus.publishPromptSuggestion(state.sessionId, suggestion)
    }
  }

  if (msg.type === "system" && msg.subtype === "status") {
    // The CLI reports `compacting` when it starts summarising and clears the
    // status (with a compact_result) when it is done.
    streamBus.publishCompacting(state.sessionId, msg.status === "compacting")
    adoptPermissionMode(state, msg.permissionMode)
  }

  if (msg.type === "system" && msg.subtype === "session_writes_lost") {
    streamBus.publishError(state.sessionId, describeWritesLost(msg))
  }

  if (msg.type === "rate_limit_event") {
    // The runtime reports every change, so an "allowed" report is what lifts a
    // block — the refused turn's own result says only that it failed, never
    // that the allowance came back.
    const info = (msg as unknown as { rate_limit_info?: unknown }).rate_limit_info
    streamBus.publishRateLimit(state.sessionId, readSdkRateLimit(info))
  }

  if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
    state.backgroundAgents = new Set(
      msg.tasks
        .filter((task) => !task.ambient && BACKGROUND_AGENT_TASK_TYPES.has(task.task_type))
        .map((task) => task.task_id),
    )
  }

  if (msg.type === "system" && msg.subtype === "task_started") {
    // A resumed subagent reports the same task id again; its transcript stays
    // filed under the call that first launched it.
    if (msg.tool_use_id && !state.subagentTasks.has(msg.task_id)) {
      state.subagentTasks.set(msg.task_id, {
        toolUseId: msg.tool_use_id,
        parentTaskId: msg.parent_task_id,
        subagentType: msg.subagent_type,
        forwardedBytes: 0,
      })
      state.subagentWatcher?.rescan()
    }
  }

  if (msg.type === "system" && msg.subtype === "task_progress") {
    // `summary` is absent until the first ~30s fork completes, and the UI keys
    // on the tool_use id of the card it decorates — without either there is
    // nothing to render.
    const progress = msg as unknown as { tool_use_id?: string; summary?: string }
    if (progress.tool_use_id && progress.summary) {
      streamBus.publishAgentProgress(state.sessionId, progress.tool_use_id, progress.summary)
    }
  }

  if (msg.type === "stream_event") {
    const ev = msg as unknown as {
      event: streamBus.RawStreamEvent
      parent_tool_use_id: string | null
    }
    streamBus.publish(state.sessionId, ev.event, ev.parent_tool_use_id ?? null)
  }

  if (msg.type === "assistant") {
    const raw = msg as unknown as Record<string, unknown>
    const message = raw.message as { id?: string; content?: unknown[] } | undefined
    const parentToolUseId = (raw.parent_tool_use_id as string | null | undefined) ?? null

    // With forwardSubagentText enabled, subagents' own COMPLETE messages flow
    // through here (the SDK emits no token-level stream events for subagents).
    // Publish them to the bus for the live transcript.
    if (parentToolUseId !== null) {
      const content = message?.content as Array<{ type: string; text?: string; thinking?: string }> | undefined
      if (message?.id && Array.isArray(content)) {
        const textBlocks: Array<{ blockType: "text" | "thinking"; text: string }> = []
        for (const block of content) {
          if (block.type === "text" && block.text) {
            textBlocks.push({ blockType: "text", text: block.text })
          } else if (block.type === "thinking" && block.thinking) {
            textBlocks.push({ blockType: "thinking", text: block.thinking })
          }
        }
        if (textBlocks.length > 0) {
          streamBus.publishCompleteMessage(state.sessionId, {
            messageId: message.id,
            parentToolUseId,
            blocks: textBlocks,
          })
        }
      }
      return
    }

    // Main thread: the complete message now exists in the JSONL — drop the
    // stream copy so a late snapshot never duplicates the file tail.
    if (message?.id) {
      streamBus.completeMessage(state.sessionId, message.id)
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Pushable input stream for a long-lived SDK query.
 *
 * Passing this stream to query() is the SDK's supported multi-turn mode. New
 * messages are queued by the CLI and processed sequentially, so sending a
 * follow-up does not interrupt foreground work or replace background workflows
 * with a second resumed process.
 */
class SDKMessageStream implements AsyncIterableIterator<SDKUserMessage> {
  private queued: SDKUserMessage[] = []
  private waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  enqueue(message: SDKUserMessage): boolean {
    if (this.closed) return false
    const resolve = this.waiting.shift()
    if (resolve) resolve({ value: message, done: false })
    else this.queued.push(message)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queued.length = 0
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const message = this.queued.shift()
    if (message) return Promise.resolve({ value: message, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  return(): Promise<IteratorResult<SDKUserMessage>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    return this
  }
}

// ── Run a query and iterate in background ────────────────────────────

function runQuery(state: SDKSessionState, prompt: string, opts: {
  isResume?: boolean
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
  images?: ImageAttachment[]
  beforeFirstTurn?: (identity: { sessionId?: string; cwd: string; nativeWorktree?: boolean }) => Promise<void>
  onStartupError?: (error: unknown) => void
}, pluginInstructions?: string, preparation?: AbortController): void {
  if (pluginInstructions === undefined) {
    const loading = pluginSkillContext(state.cwd)
    if (loading) {
      const abort = new AbortController()
      state.abort = abort; state.running = true; state.pluginSkillLoading = true
      void loading.then(instructions => { if (state.abort === abort && !abort.signal.aborted) { state.pluginSkillLoading = false; runQuery(state, prompt, opts, instructions, abort) } }).catch(error => {
        if (state.abort !== abort || abort.signal.aborted) return
        state.pluginSkillLoading = false; state.running = false
        state.messageStream?.close(); state.messageStream = null
        abort.abort()
        const result = { type: "result", is_error: true, result: String(error) }
        logTurnFailure(state, result)
        notifyResultObservers(state, result, true)
        const callback = state.onResult
        state.onResult = null
        if (callback) callback(result)
        else streamBus.publishError(state.sessionId, result.result)
      })
      return
    }
  }
  state.abort = preparation ?? new AbortController()
  state.running = true
  state.backgroundAgents = NO_BACKGROUND_AGENTS
  state.stderr = ""

  state.capabilities = NO_CAPABILITIES
  const queryOpts = buildQueryOptions(state, opts)
  state.launchMcpServers = queryOpts.mcpServers ?? null
  if (pluginInstructions) queryOpts.systemPrompt = appendToSystemPrompt(queryOpts.systemPrompt, pluginInstructions)
  const messageStream = new SDKMessageStream()
  const first = buildUserMessage(prompt, opts.images)
  inputTurns.set(state, { sent: [first.uuid!], completed: 0, taken: null })
  if (opts.beforeFirstTurn) {
    // The CLI never calls an SDK SessionStart callback. It does hold each
    // prompt until UserPromptSubmit returns, and reports the session's own cwd
    // there, which for `--worktree` is the initialized worktree.
    let readiness: Promise<void> | undefined
    queryOpts.hooks = {
      ...queryOpts.hooks,
      UserPromptSubmit: [...(queryOpts.hooks?.UserPromptSubmit ?? []), { timeout: 86400, hooks: [async (input) => {
        try {
          await (readiness ??= (async () => {
            state.cwd = input.cwd
            await opts.beforeFirstTurn!({ sessionId: state.sessionId, cwd: input.cwd })
            state.abort?.signal.throwIfAborted()
          })())
          return {}
        } catch (error) {
          opts.onStartupError?.(error)
          messageStream.close()
          state.abort?.abort()
          return { continue: false, decision: "block", reason: "Worktree startup did not complete" }
        }
      }] }],
    }
  }
  messageStream.enqueue(first)
  state.messageStream = messageStream

  // Streaming input keeps one SDK/CLI process alive across turns. This is
  // essential for Ultracode because workflows can continue after the parent
  // turn's result event has been emitted.
  const q = query({ prompt: messageStream, options: queryOpts })
  state.activeQuery = q
  // Idle sessions keep their resolved JSONL path. Reattach only for the live
  // query; the finally block below releases the watcher when the process ends.
  attachSubagentWatcher(state)

  ;(async () => {
    let failureLogged = false
    // The SDK rethrows the last error result's text when the CLI exits after it.
    let lastErrorResult: Record<string, unknown> | null = null
    try {
      for await (const msg of q) {
        if (msg.type === "result") lastErrorResult = msg.is_error ? msg as unknown as Record<string, unknown> : null
        processSDKEvent(state, msg)
      }
    } catch (err) {
      const base = lastErrorResult ? describeErrorResult(lastErrorResult) : String(err)
      const detail = state.stderr?.trim()
      // Append captured stderr so the surfaced error is verbose enough to
      // diagnose (the SDK's own message is just "exited with code 1").
      const result = detail && !base.includes(detail) ? `${base}\n\n${detail}` : base
      if (hasUnfinishedWork(state)) { logTurnFailure(state, { is_error: true, result }); failureLogged = true }
      notifyResultObservers(state, { is_error: true, result }, true)
      if (state.onResult) {
        state.onResult({ type: "result", is_error: true, result })
        state.onResult = null
      } else {
        streamBus.publishError(state.sessionId, result)
      }
    } finally {
      // A newer query can already be running for this session — either a resume
      // replaced the state object, or sendSDKMessage restarted the turn on this
      // same one. Everything shared with that successor (stream, watcher,
      // running flag, pending prompts) must only be torn down by the query that
      // still owns it, or this finally blanks a live turn seconds after it began.
      const ownsSession = state.activeQuery === q
      // A query that already answered every turn ends quietly; one that dies
      // with a turn still owed is a failure worth a log line.
      const ended = { is_error: true, result: "Session ended before the turn completed" }
      if (!failureLogged && ownsSession && hasUnfinishedWork(state)) logTurnFailure(state, ended)
      messageStream.close()
      if (ownsSession) {
        state.subagentWatcher?.close()
        state.subagentWatcher = null
        state.running = false
        state.backgroundAgents = NO_BACKGROUND_AGENTS
        streamBus.clear(state.sessionId)
      }
      if (state.messageStream === messageStream) state.messageStream = null
      if (state.activeQuery === q) state.activeQuery = null
      if (state.abort === queryOpts.abortController) state.abort = null
      if (ownsSession) rejectAllPending(state, "Session ended")
      notifyResultObservers(state, ended, true)
      // The iterator can finish without ever yielding a `result` — Query.close()
      // (teardownState/stopSDKSession) ends it cleanly rather than throwing. Any
      // HTTP response parked on onResult would otherwise never end, leaving the
      // composer stuck showing a running turn forever.
      if (state.onResult) {
        state.onResult({
          type: "result",
          is_error: true,
          result: "Session ended before the turn completed",
        })
        state.onResult = null
      }
    }
  })()
}

function rejectAllPending(state: SDKSessionState, reason: string): void {
  for (const pending of state.pendingPermissions.values()) {
    pending.resolve({ behavior: "deny", message: reason })
  }
  state.pendingPermissions.clear()
  for (const pending of state.pendingUserQuestions.values()) {
    pending.resolve({ behavior: "deny", message: reason, interrupt: true })
  }
  state.pendingUserQuestions.clear()
  // The MCP server and the CLI both distinguish "the user said no" from "the
  // user never got to answer"; a torn-down session is the latter.
  for (const pending of state.pendingElicitations.values()) {
    pending.resolve({ action: "cancel" })
  }
  state.pendingElicitations.clear()
  for (const pending of state.pendingUserDialogs.values()) {
    pending.resolve({ behavior: "cancelled" })
  }
  state.pendingUserDialogs.clear()
}

// ── Helper: build an SDKUserMessage from text + optional images ──────

function buildUserMessage(
  message: string,
  images?: ImageAttachment[],
  startsTurn = true,
): SDKUserMessage {
  const content: MessageParam["content"] = []
  if (images?.length) {
    for (const img of images) {
      content.push({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: img.data,
        },
      })
    }
  }
  // Always include a text block — the API rejects empty content with
  // cache_control, which the SDK may add automatically.
  content.push({
    type: "text" as const,
    text: message || "See the attached image(s).",
  })
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    // The CLI still folds it into a running turn; an idle one only records it.
    ...(startsTurn ? {} : { shouldQuery: false }),
  }
}

// ── Create a new SDK session ─────────────────────────────────────────

interface SDKSessionInitOpts {
  sessionId: string
  cwd: string
  message: string
  images?: ImageAttachment[]
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string
  fastMode?: boolean
  ultracode?: boolean
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
  beforeFirstTurn?: (identity: { sessionId?: string; cwd: string; nativeWorktree?: boolean }) => Promise<void>
  onStartupError?: (error: unknown) => void
}

function initSDKSessionState(opts: SDKSessionInitOpts): SDKSessionState {
  return {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    pendingPermissions: new Map(),
    pendingUserQuestions: new Map(),
    pendingElicitations: new Map(),
    pendingUserDialogs: new Map(),
    running: false,
    backgroundAgents: NO_BACKGROUND_AGENTS,
    abort: null,
    activeQuery: null,
    messageStream: null,
    onResult: null,
    onInit: null,
    jsonlPath: null,
    subagentTasks: new Map(),
    subagentWatcher: null,
    permissionMode: opts.permissionMode || (canSkipPermissions() ? "bypassPermissions" : "default"),
    capabilities: NO_CAPABILITIES,
    launchMcpServers: null,
    allowedTools: opts.allowedTools ? [...opts.allowedTools] : [],
    disallowedTools: opts.disallowedTools ? [...opts.disallowedTools] : [],
    model: opts.model,
    effort: opts.effort,
    fastMode: opts.fastMode,
    ultracode: opts.ultracode,
    mcpConfig: opts.mcpConfig,
  }
}

export function createSDKSession(opts: SDKSessionInitOpts): SDKSessionState {
  const state = initSDKSessionState(opts)
  sdkSessions.set(opts.sessionId, state)
  runQuery(state, opts.message, {
    name: opts.name,
    worktreeName: opts.worktreeName,
    beforeFirstTurn: opts.beforeFirstTurn,
    onStartupError: opts.onStartupError,
    mcpConfig: opts.mcpConfig,
    images: opts.images,
  })
  return state
}

// ── Send a follow-up message ────────────────────────────────────────
// If the query is still running, use streamInput() to inject the message
// mid-turn. Otherwise start a new resume query.
//
// `updates` carries the latest UI-side settings for effort/model/mcpConfig.
// We record them on `state` so that any subsequent query restart picks up the
// newest values; an empty model or effort is no override (see sendOverrides).
// When the query is still live we also push model/effort changes into the
// running SDK Query via setModel() and applyFlagSettings() — the SDK has no
// setEffort, but effortLevel in the settings layer is the documented way to
// change reasoning effort mid-session.

export interface SDKSessionUpdates {
  model?: string
  effort?: string
  fastMode?: boolean
  ultracode?: boolean
  mcpConfig?: string | null
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
}

interface AppliedSessionUpdates {
  modelChanged: boolean
  effortChanged: boolean
  fastModeChanged: boolean
  ultracodeChanged: boolean
  permissionModeChanged: boolean
  /** The mode before the update, which a refused switch keeps. */
  previousPermissionMode: string
  permissionsChanged: boolean
  mcpConfigChanged: boolean
  nextEffort?: string
}

function applySessionUpdates(
  state: SDKSessionState,
  updates?: SDKSessionUpdates,
): AppliedSessionUpdates {
  const previousEffort = state.effort
  const previousPermissionMode = state.permissionMode
  const modelChanged = updates?.model !== undefined && updates.model !== state.model
  const fastModeChanged = updates?.fastMode !== undefined && updates.fastMode !== state.fastMode
  const ultracodeChanged = updates?.ultracode !== undefined && updates.ultracode !== state.ultracode
  const permissionModeChanged = updates?.permissionMode !== undefined
    && updates.permissionMode !== state.permissionMode
  const permissionsChanged = updates?.allowedTools !== undefined
    || updates?.disallowedTools !== undefined
  const mcpConfigChanged = updates?.mcpConfig !== undefined && updates.mcpConfig !== state.mcpConfig

  if (updates) {
    if (updates.model !== undefined) state.model = updates.model
    if (updates.effort !== undefined) state.effort = updates.effort
    if (updates.fastMode !== undefined) state.fastMode = updates.fastMode
    if (updates.ultracode !== undefined) state.ultracode = updates.ultracode
    if (updates.mcpConfig !== undefined) state.mcpConfig = updates.mcpConfig
    if (updates.permissionMode !== undefined) state.permissionMode = updates.permissionMode
    if (updates.allowedTools !== undefined) state.allowedTools = [...updates.allowedTools]
    if (updates.disallowedTools !== undefined) state.disallowedTools = [...updates.disallowedTools]
  }

  const nextEffort = state.effort
  return {
    modelChanged,
    effortChanged: nextEffort !== undefined && nextEffort !== previousEffort,
    fastModeChanged,
    ultracodeChanged,
    permissionModeChanged,
    previousPermissionMode,
    permissionsChanged,
    mcpConfigChanged,
    nextEffort,
  }
}

/** What a live update got through to the running process, recorded as it goes. */
interface PushedUpdates {
  applied: string[]
  /** Pending requests the new permission mode approved. */
  autoApproved: AutoApprovedRequest[]
}

/**
 * Ask the running CLI to switch modes; false when it refused and kept its mode.
 * A process that exits meanwhile fails the request too, which throws: the
 * requested mode then waits for the next resume.
 */
async function switchPermissionMode(state: SDKSessionState, queryHandle: Query, requested: string, previous: string): Promise<boolean> {
  try {
    await queryHandle.setPermissionMode(requested as PermissionMode)
    return true
  } catch (error) {
    // The SDK fails the request just before the ended query reaches runQuery.
    await new Promise((resolve) => setImmediate(resolve))
    if (state.activeQuery !== queryHandle || !isSDKQueryLive(state)) throw error
    // The CLI keeps its mode: bypassPermissions in a process launched
    // without it, auto mode where it is unavailable.
    if (state.permissionMode === requested) state.permissionMode = previous
    streamBus.publishError(state.sessionId, `The session kept its permission mode. ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Send the changes to the running process, recording each one it took in
 * `pushed` — a failure part-way keeps the record of what went before it.
 */
async function pushSessionUpdates(
  state: SDKSessionState,
  changes: AppliedSessionUpdates,
  pushed: PushedUpdates = { applied: [], autoApproved: [] },
): Promise<void> {
  const queryHandle = state.activeQuery
  if (!queryHandle) return
  const { applied } = pushed

  if (changes.modelChanged) {
    await queryHandle.setModel(state.model || undefined)
    applied.push("model")
  }
  if (changes.permissionModeChanged) {
    const requested = state.permissionMode
    // Asks raised before the switch was sent are the old mode's to answer;
    // one raised after it may be one the CLI asks even in the new mode.
    const askedBefore = [...state.pendingPermissions.keys()]
    if (await switchPermissionMode(state, queryHandle, requested, changes.previousPermissionMode)) {
      // A status report from before the switch may have moved the mode back.
      adoptPermissionMode(state, requested)
      applied.push("permissionMode")
      pushed.autoApproved.push(...autoResolvePendingForMode(state, askedBefore))
    }
  }

  const flagSettings: Record<string, unknown> = {}
  // An effort change sent without the ultracode key switches ultracode off, so
  // a session that has it on re-states it alongside the new level.
  if (changes.ultracodeChanged || (changes.effortChanged && state.ultracode)) {
    flagSettings.ultracode = state.ultracode ?? false
    flagSettings.enableWorkflows = state.ultracode ?? false
  }
  if (changes.fastModeChanged) flagSettings.fastMode = state.fastMode ?? false
  if (changes.permissionsChanged) {
    flagSettings.permissions = {
      allow: state.allowedTools,
      deny: state.disallowedTools,
      defaultMode: (state.permissionMode || "default") as PermissionMode,
    }
  }
  // applyFlagSettings takes "max" even though the persisted effortLevel setting
  // excludes it — the SDK scopes it to the session. An empty effort means "use
  // the provider default", which null expresses by clearing the flag layer.
  if (changes.effortChanged) {
    flagSettings.effortLevel = changes.nextEffort || null
  }
  if (Object.keys(flagSettings).length > 0) {
    await queryHandle.applyFlagSettings(
      flagSettings as Parameters<Query["applyFlagSettings"]>[0],
    )
    applied.push(...Object.keys(flagSettings))
  }

  if (changes.mcpConfigChanged) {
    try {
      const servers = state.mcpConfig
        ? JSON.parse(state.mcpConfig) as Record<string, McpServerConfig>
        : {}
      // A server from the launch option disconnects only once a call has
      // named it, so the first change hands those over before it applies.
      if (state.launchMcpServers) {
        await queryHandle.setMcpServers(state.launchMcpServers)
        state.launchMcpServers = null
      }
      await queryHandle.setMcpServers(servers)
      applied.push("mcpConfig")
    } catch {
      // Invalid or provider-managed MCP configuration remains staged for the
      // next query, where the normal SDK option validation will report it.
    }
  }
}

// Switching permission mode mid-turn must take effect immediately: once the
// CLI runs in the new mode, approvals the user is currently being asked for are
// re-evaluated under it so the turn continues without further clicks.
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** A pending tool request that a permission mode change approved without asking. */
export interface AutoApprovedRequest {
  requestId: string
  toolName: string
}

/**
 * Whether a switch to `mode` answers a pending ask: bypassPermissions any,
 * acceptEdits a file edit inside the workspace (outside it the CLI still
 * asks). Never one the CLI or the user's own ask rule wants a person for.
 */
function modeApproves(mode: string, pending: PendingPermission): boolean {
  if (pending.defaultToNo || pending.suppressAlwaysAllowRule || pending.matchedAskRule) return false
  if (mode === "bypassPermissions") return true
  return mode === "acceptEdits" && EDIT_TOOL_NAMES.has(pending.toolName) && !pending.blockedPath
}

/** Approve those of the asks `requestIds` names that are still pending and the session's new mode answers. */
function autoResolvePendingForMode(state: SDKSessionState, requestIds: readonly string[]): AutoApprovedRequest[] {
  const approved: AutoApprovedRequest[] = []
  for (const requestId of requestIds) {
    const pending = state.pendingPermissions.get(requestId)
    if (!pending || !modeApproves(state.permissionMode, pending)) continue
    state.pendingPermissions.delete(requestId)
    applyDecision(pending, "allow")
    approved.push({ requestId, toolName: pending.toolName })
  }
  return approved
}

/** A session's permission settings after an update changed them, and the requests the new mode approved on the spot. */
export type PermissionSettingsChange = {
  permissionMode: string
  allowedTools: string[]
  disallowedTools: string[]
  autoApproved: AutoApprovedRequest[]
}

export interface SDKSessionUpdateResult {
  found: boolean
  appliedLive: string[]
  staged: string[]
  /** Null when the update left the permission mode and tool rules as they were. */
  permissionChange: PermissionSettingsChange | null
  /** The mode the session runs in afterwards, which a refused switch leaves as it was. */
  permissionMode?: string
}

function permissionSettingsOf(state: SDKSessionState): Omit<PermissionSettingsChange, "autoApproved"> {
  return {
    permissionMode: state.permissionMode,
    allowedTools: [...state.allowedTools],
    disallowedTools: [...state.disallowedTools],
  }
}

export async function updateSDKSession(
  sessionId: string,
  updates: SDKSessionUpdates,
): Promise<SDKSessionUpdateResult> {
  const state = sdkSessions.get(sessionId)
  if (!state) return { found: false, appliedLive: [], staged: Object.keys(updates), permissionChange: null }
  const permissionsBefore = JSON.stringify(permissionSettingsOf(state))
  const changes = applySessionUpdates(state, updates)
  const pushed: PushedUpdates = { applied: [], autoApproved: [] }
  try {
    await pushSessionUpdates(state, changes, pushed)
  } catch {
    // The query may finish between checking `running` and sending a control
    // request. State is still updated, so the next resume applies the values.
  }
  const { applied, autoApproved } = pushed
  const permissionsAfter = permissionSettingsOf(state)
  const refused = changes.permissionModeChanged && state.permissionMode === changes.previousPermissionMode
  return {
    found: true,
    appliedLive: applied,
    staged: Object.keys(updates).filter((key) => !applied.includes(key) && !(refused && key === "permissionMode")),
    permissionChange: JSON.stringify(permissionsAfter) === permissionsBefore
      ? null
      : { ...permissionsAfter, autoApproved },
    permissionMode: state.permissionMode,
  }
}

type LiveSDKSessionState = SDKSessionState & {
  activeQuery: NonNullable<SDKSessionState["activeQuery"]>
  messageStream: NonNullable<SDKSessionState["messageStream"]>
}

/**
 * Whether this session's query can still accept input.
 *
 * The SDK aborts the whole query when its transport write fails (the CLI
 * process died), but `activeQuery` and `messageStream` stay set until
 * runQuery's finally block runs. Enqueuing during that window is accepted and
 * then silently dropped, so an aborted query must count as dead: callers
 * resume instead, which respawns the CLI and actually delivers the message.
 */
export function isSDKQueryLive(
  state: SDKSessionState | null | undefined,
): state is LiveSDKSessionState {
  return Boolean(state?.activeQuery && state.messageStream && !state.abort?.signal.aborted)
}

/**
 * A send's empty model or effort asks for no override, as it does when a
 * resume omits the flag: the session keeps what it runs. Only a settings
 * change (`updateSDKSession`) picks the provider default with an empty value.
 */
function sendOverrides(updates?: SDKSendUpdates): SDKSendUpdates | undefined {
  if (!updates) return undefined
  const { model, effort, ...rest } = updates
  return { ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Settings a send carries; the permission mode and tool rules change only through updateSDKSession. */
export type SDKSendUpdates = Omit<SDKSessionUpdates, "permissionMode" | "allowedTools" | "disallowedTools">

export function sendSDKMessage(
  sessionId: string,
  message: string,
  images?: ImageAttachment[],
  updates?: SDKSendUpdates,
  { startsTurn = true }: { startsTurn?: boolean } = {},
): SDKSessionState | null {
  const state = sdkSessions.get(sessionId)
  if (!state) return null

  const changes = applySessionUpdates(state, sendOverrides(updates))

  if (isSDKQueryLive(state)) {
    const input = buildUserMessage(message, images, startsTurn)
    if (!state.messageStream.enqueue(input)) return null
    const turns = inputTurns.get(state)
    if (turns) turns.sent.push(input.uuid!)
    state.running = true

    // Best-effort: the setting is already persisted on `state`, so a failed
    // control request still applies on the next resume.
    void pushSessionUpdates(state, changes).catch(() => {})
    return state
  }

  // Session idle — start a new resume query with the freshly-updated state
  runQuery(state, message, { isResume: true, mcpConfig: state.mcpConfig, images })
  return state
}

// ── Resume a dead SDK session (creates fresh state + runs resume query) ──

export function resumeSDKSession(opts: SDKSessionInitOpts): SDKSessionState {
  // A resume supersedes whatever query held this id. Tear the old one down
  // first so its CLI process can't keep appending to the same transcript.
  const previous = sdkSessions.get(opts.sessionId)
  if (previous) teardownState(previous)

  const state = initSDKSessionState(opts)
  sdkSessions.set(opts.sessionId, state)
  runQuery(state, opts.message, { isResume: true, mcpConfig: opts.mcpConfig, images: opts.images })
  return state
}

// ── Resolve a single permission request ──────────────────────────────

/**
 * Whether "always allow" can be offered: it saves the rule the CLI suggested
 * for this ask, and an ask without one, or one the CLI will save nothing for,
 * is answered once.
 */
export function offersAlwaysAllow(request: Pick<PermissionRequestData, "suggestions" | "suppressAlwaysAllowRule">): boolean {
  return !request.suppressAlwaysAllowRule && (request.suggestions?.length ?? 0) > 0
}

function applyDecision(pending: PendingPermission, behavior: PermissionDecision): void {
  if (behavior === "deny") {
    pending.resolve({ behavior: "deny", message: "User declined tool execution." })
    return
  }
  pending.resolve({
    behavior: "allow",
    updatedInput: pending.input,
    ...(behavior === "allow_always" && offersAlwaysAllow(pending) ? { updatedPermissions: pending.suggestions } : {}),
  })
}

export function resolvePermission(
  sessionId: string,
  requestId: string,
  behavior: PermissionDecision,
): { found: boolean; toolName?: string } {
  const state = sdkSessions.get(sessionId)
  const pending = state?.pendingPermissions.get(requestId)
  if (!state || !pending) return { found: false }

  state.pendingPermissions.delete(requestId)
  applyDecision(pending, behavior)

  return { found: true, toolName: pending.toolName }
}

function normalizeUserQuestionAnswers(
  input: Record<string, unknown>,
  answers: UserQuestionAnswers,
): Record<string, string> | null {
  if (typeof answers === "object" && answers !== null && !Array.isArray(answers)) {
    const entries = Object.entries(answers)
    if (entries.some(([, value]) => typeof value !== "string")) return null
    return Object.fromEntries(entries) as Record<string, string>
  }

  const questions = Array.isArray(input.questions)
    ? input.questions.filter((question): question is Record<string, unknown> => (
      typeof question === "object" && question !== null
    ))
    : []
  const values = Array.isArray(answers) ? answers : [answers]
  const normalized: Record<string, string> = {}
  for (let index = 0; index < values.length; index += 1) {
    const question = questions[index]?.question
    const answer = values[index]
    if (typeof question === "string" && typeof answer === "string") {
      normalized[question] = answer
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

/** The CLI capability that lets an answer say a question went unanswered, and how. */
export const UNANSWERED_QUESTIONS_CAPABILITY = "ask_user_question_unanswered_v1"

/** What the agent reads for a skipped question. */
export const SKIPPED_QUESTION_ANSWER = "The user skipped this question."

/**
 * One answer for every question of the call: the skip notice, or the chat
 * message the user sent instead of answering.
 */
function unansweredAnswers(
  input: Record<string, unknown>,
  answers: UserQuestionAnswers,
  unanswered: QuestionUnanswered,
): Record<string, string> | null {
  const reply = typeof answers === "string" ? answers : (Array.isArray(answers) ? answers : Object.values(answers)).join("\n")
  const text = unanswered === "skipped" ? SKIPPED_QUESTION_ANSWER : reply.trim()
  const questions = projectQuestions(input).map(({ question }) => question)
  return text && questions.length > 0 ? Object.fromEntries(questions.map((question) => [question, text])) : null
}

/**
 * Resolve the blocked AskUserQuestion tool with the SDK's expected input shape.
 * An `unanswered` reply answers every question alike, and is recorded as such
 * in the transcript where the CLI supports it.
 */
export function resolveUserQuestion(
  sessionId: string,
  toolUseId: string,
  answers: UserQuestionAnswers,
  unanswered?: QuestionUnanswered,
): { found: boolean } {
  const state = sdkSessions.get(sessionId)
  if (!state) return { found: false }

  const pending = state.pendingUserQuestions.get(toolUseId)
  if (!pending) return { found: false }
  const normalized = unanswered
    ? unansweredAnswers(pending.input, answers, unanswered)
    : normalizeUserQuestionAnswers(pending.input, answers)
  if (!normalized) return { found: false }
  // An older CLI refuses the whole answer over a key it does not know.
  const annotations = unanswered && state.capabilities.has(UNANSWERED_QUESTIONS_CAPABILITY)
    ? Object.fromEntries(Object.keys(normalized).map((question) => [question, { unanswered }]))
    : null

  state.pendingUserQuestions.delete(toolUseId)
  pending.resolve({
    behavior: "allow",
    updatedInput: { ...pending.input, answers: normalized, ...(annotations ? { annotations } : {}) },
  })
  return { found: true }
}

// ── Resolve a parked MCP elicitation / CLI dialog ────────────────────

/** ElicitResult content is flat: strings, numbers, booleans and string lists. */
export function normalizeElicitationContent(content: unknown): ElicitationContent | null {
  if (content === undefined) return null
  if (typeof content !== "object" || content === null || Array.isArray(content)) return null
  const normalized: ElicitationContent = {}
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      normalized[key] = value
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      normalized[key] = value as string[]
    } else {
      return null
    }
  }
  return normalized
}

export function resolveElicitation(
  sessionId: string,
  requestId: string,
  response: { action: ElicitationAction; content?: ElicitationContent },
): { found: boolean } {
  const state = sdkSessions.get(sessionId)
  const pending = state?.pendingElicitations.get(requestId)
  if (!state || !pending) return { found: false }
  if (response.action !== "accept" && response.action !== "decline" && response.action !== "cancel") {
    return { found: false }
  }

  let content: ElicitationContent | undefined
  if (response.action === "accept" && response.content !== undefined) {
    const normalized = normalizeElicitationContent(response.content)
    // Leave it parked: a rejected answer is a client bug, and dropping the
    // request here would strand the MCP server with no response at all.
    if (!normalized) return { found: false }
    content = normalized
  }

  state.pendingElicitations.delete(requestId)
  pending.resolve(content ? { action: response.action, content } : { action: response.action })
  return { found: true }
}

export function resolveUserDialog(
  sessionId: string,
  requestId: string,
  choice: UserDialogChoice,
): { found: boolean } {
  const state = sdkSessions.get(sessionId)
  const pending = state?.pendingUserDialogs.get(requestId)
  if (!state || !pending) return { found: false }
  if (!DIALOG_CHOICES[pending.dialog.dialogKind]?.has(choice)) return { found: false }

  state.pendingUserDialogs.delete(requestId)
  pending.resolve(
    choice === "cancelled" ? { behavior: "cancelled" } : { behavior: "completed", result: choice },
  )
  return { found: true }
}

/** Elicitations blocking a session, as the dashboard renders them. */
export function getSDKElicitations(sessionId: string): MissionControlElicitation[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []
  return Array.from(state.pendingElicitations, ([requestId, pending]) => {
    const { request } = pending
    return {
      sessionId,
      requestId,
      serverName: request.serverName,
      message: request.message,
      mode: request.mode === "url" ? "url" as const : "form" as const,
      ...(request.url ? { url: request.url } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.displayName ? { displayName: request.displayName } : {}),
      ...(request.description ? { description: request.description } : {}),
      askedAt: pending.askedAt,
      fields: pending.fields,
    }
  })
}

/** Dialogs blocking a session, as the dashboard renders them. */
export function getSDKUserDialogs(sessionId: string): MissionControlUserDialog[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []
  return Array.from(state.pendingUserDialogs.values(), (pending) => ({
    sessionId,
    ...pending.dialog,
  }))
}

/** Sessions parked on an elicitation or a dialog. */
export function listAgentPromptSessionIds(): string[] {
  const ids: string[] = []
  for (const [sessionId, state] of sdkSessions) {
    if (state.pendingElicitations.size > 0 || state.pendingUserDialogs.size > 0) {
      ids.push(sessionId)
    }
  }
  return ids
}

// ── Resolve all pending permission requests ──────────────────────────

/** Answer every pending request of a session alike, returning the requests it answered. */
export function resolveAllPermissions(
  sessionId: string,
  behavior: PermissionDecision,
): PermissionRequestData[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []

  const resolved = Array.from(state.pendingPermissions.values(), permissionRequestOf)
  for (const pending of state.pendingPermissions.values()) applyDecision(pending, behavior)
  state.pendingPermissions.clear()
  return resolved
}

// ── Get pending permission requests ──────────────────────────────────

export function getSDKPermissions(sessionId: string): PermissionRequestData[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []
  return Array.from(state.pendingPermissions.values(), permissionRequestOf)
}

// ── Get pending AskUserQuestion calls ────────────────────────────────

/**
 * Project a raw AskUserQuestion input down to what a dashboard can render.
 *
 * Option `preview` payloads (mockups, code snippets) are dropped and replaced
 * with a boolean: they can run to kilobytes each and this list is polled, so
 * shipping them would put real weight on every remote and tunnel client.
 */
function projectQuestions(input: Record<string, unknown>): MissionControlQuestionItem[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  const items: MissionControlQuestionItem[] = []
  for (const entry of raw) {
    const q = asRecord(entry) ?? {}
    const question = typeof q.question === "string" ? q.question : ""
    if (!question) continue
    const rawOptions = Array.isArray(q.options) ? q.options : []
    items.push({
      question,
      ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true,
      options: rawOptions.flatMap((o) => {
        const option = asRecord(o) ?? {}
        const label = typeof option.label === "string" ? option.label : ""
        if (!label) return []
        return [{
          label,
          ...(typeof option.description === "string" && option.description
            ? { description: option.description }
            : {}),
          hasPreview: typeof option.preview === "string" && option.preview.length > 0,
        }]
      }),
    })
  }
  return items
}

/**
 * Pending questions for a session.
 *
 * The Map key is the toolUseId, and it is the only thing that can answer the
 * call — deriving it from a transcript instead would go stale silently.
 */
export function getSDKUserQuestions(sessionId: string): MissionControlQuestion[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []
  return Array.from(state.pendingUserQuestions, ([toolUseId, pending]) => ({
    sessionId,
    toolUseId,
    askedAt: pending.askedAt,
    questions: projectQuestions(pending.input),
  }))
}

/**
 * Sessions currently blocked on a question.
 *
 * Only SDK sessions: Codex has no equivalent (its app-server rejects any
 * method outside its approval pair), and legacy CLI sessions have no question
 * map, so there is nothing to union in.
 */
export function listUserQuestionSessionIds(): string[] {
  const ids: string[] = []
  for (const [sessionId, state] of sdkSessions) {
    if (state.pendingUserQuestions.size > 0) ids.push(sessionId)
  }
  return ids
}

// ── Stop / cleanup ───────────────────────────────────────────────────

function teardownState(state: SDKSessionState): void {
  notifyResultObservers(state, { is_error: true, result: "Session was stopped" }, true)
  streamBus.clear(state.sessionId)
  rejectAllPending(state, "Session stopped")
  state.subagentWatcher?.close()
  state.subagentWatcher = null
  state.messageStream?.close()
  state.messageStream = null
  if (state.activeQuery) {
    state.activeQuery.close()
    state.activeQuery = null
  }
  state.abort?.abort()
  state.pluginSkillLoading = false
  state.running = false
  state.backgroundAgents = NO_BACKGROUND_AGENTS
}

export function stopSDKSession(sessionId: string): boolean {
  const state = sdkSessions.get(sessionId)
  if (!state) return false
  teardownState(state)
  sdkSessions.delete(sessionId)
  return true
}

export async function interruptSDKTurn(sessionId: string): Promise<boolean> {
  const state = sdkSessions.get(sessionId)
  if (!state?.running) return false
  if (state.pluginSkillLoading) {
    state.abort?.abort()
    state.pluginSkillLoading = false
    state.running = false
    const result = { type: "result", is_error: true, result: "Turn interrupted" }
    notifyResultObservers(state, result, true)
    const callback = state.onResult
    state.onResult = null
    streamBus.clear(sessionId)
    callback?.(result)
    return true
  }
  if (!state.activeQuery) return false
  await state.activeQuery.interrupt()
  return true
}

export async function stopSDKTask(sessionId: string, taskId: string): Promise<boolean> {
  const queryHandle = sdkSessions.get(sessionId)?.activeQuery
  if (!queryHandle) return false
  await queryHandle.stopTask(taskId)
  return true
}

export async function backgroundSDKTasks(
  sessionId: string,
  toolUseId?: string,
): Promise<boolean> {
  const queryHandle = sdkSessions.get(sessionId)?.activeQuery
  if (!queryHandle) return false
  return queryHandle.backgroundTasks(toolUseId)
}

export async function rewindClaudeFiles(
  sessionId: string,
  userMessageId: string,
  cwd: string,
  dryRun = false,
) {
  const active = sdkSessions.get(sessionId)?.activeQuery
  if (active) return active.rewindFiles(userMessageId, { dryRun })

  return withControlQuery(
    { cwd, resume: sessionId, enableFileCheckpointing: true },
    (q) => q.rewindFiles(userMessageId, { dryRun }),
  )
}

export function cleanupAllSDKSessions(): number {
  let killed = 0
  for (const state of sdkSessions.values()) {
    teardownState(state)
    if (state.abort) killed++
  }
  sdkSessions.clear()
  return killed
}
