import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
  Query,
} from "@anthropic-ai/claude-agent-sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { watchSubagents, type SubagentWatcher } from "./subagentWatcher"
import * as streamBus from "./lib/streamBus"

// The SDK ships the Claude CLI as a native binary inside a platform-specific
// optional package (e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64) — there
// is no cli.js next to sdk.mjs anymore. Outside Electron the SDK's own
// resolution works, so we pass undefined. In a packaged Electron app the
// binary resolves to a path inside app.asar, which cannot be spawned (asar is
// only virtualized inside Electron), so we rewrite to the unpacked copy.
export function resolveClaudeCliPath(
  resolveModule: (id: string) => string,
): string | undefined {
  try {
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const binName = process.platform === "win32" ? "claude.exe" : "claude"
    const binPath = join(dirname(resolveModule(`${platformPkg}/package.json`)), binName)
    return binPath.includes("/app.asar/")
      ? binPath.replace("/app.asar/", "/app.asar.unpacked/")
      : undefined
  } catch {
    return undefined
  }
}

const CLAUDE_CLI_PATH: string | undefined = resolveClaudeCliPath((id) =>
  createRequire(import.meta.url).resolve(id),
)

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

export interface PermissionRequestData {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  suggestions?: PermissionUpdate[]
  timestamp: number
}

interface PendingPermission extends PermissionRequestData {
  resolve: (result: PermissionResult) => void
}

interface PendingUserQuestion {
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

export type PermissionDecision = "allow" | "allow_always" | "deny"

export type ImageAttachment = { data: string; mediaType: string }

export interface SDKSessionState {
  sessionId: string
  cwd: string
  /** Permission requests awaiting user decision — canUseTool is blocked on the `resolve` promise */
  pendingPermissions: Map<string, PendingPermission>
  /** AskUserQuestion requests awaiting an answers object from the dashboard. */
  pendingUserQuestions: Map<string, PendingUserQuestion>
  /** Tools the user approved "always for this session" — canUseTool auto-allows these */
  sessionAllowedTools: Set<string>
  running: boolean
  abort: AbortController | null
  /** The live SDK Query handle. It stays alive across turn results while its input queue is open. */
  activeQuery: Query | null
  /** Persistent streaming-input queue used to add turns without resuming a competing query. */
  messageStream: {
    enqueue: (message: SDKUserMessage) => boolean
    close: () => void
  } | null
  onResult: ((msg: Record<string, unknown>) => void) | null
  jsonlPath: string | null
  pendingTaskCalls: Map<string, string>
  /** Watches sub-agent JSONL files and synthesizes progress into parent JSONL */
  subagentWatcher: SubagentWatcher | null
  worktreeName: string | null
  permissionMode: string
  allowedTools: string[]
  disallowedTools: string[]
  model?: string
  effort?: string
  /** Fast is a Claude session setting, independent from reasoning effort. */
  fastMode?: boolean
  /** Ultracode: xhigh effort + standing dynamic-workflow orchestration for the
   *  session. Set at launch via the SDK `settings` option (the --settings path);
   *  forces effort to xhigh and ensures Workflows are enabled. */
  ultracode?: boolean
  mcpConfig?: string | null
  /** stderr captured from the Claude CLI subprocess for the current run —
   *  surfaced in the error result so failures show the real reason (e.g. a
   *  missing native binary or glibc mismatch) instead of "exited with code 1". */
  stderr?: string
}

export const sdkSessions = new Map<string, SDKSessionState>()

// ── Attach the sub-agent file watcher once the JSONL path is known ──

export function attachSubagentWatcher(state: SDKSessionState): void {
  // A path lookup can finish after a short query has already completed. Never
  // attach a permanent poller to an idle session in that race.
  if (state.subagentWatcher || !state.jsonlPath || !state.activeQuery) return
  state.subagentWatcher = watchSubagents(
    state.jsonlPath,
    state.sessionId,
    state.pendingTaskCalls,
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

    // In bypassPermissions mode the CLI normally never consults canUseTool for
    // regular tools — the callback is registered only so AskUserQuestion (above)
    // has somewhere to route its answers. If the CLI ever does call it, auto-
    // allow instead of queuing an invisible permission request.
    if (state.permissionMode === "bypassPermissions") {
      return Promise.resolve<PermissionResult>({ behavior: "allow", updatedInput: input })
    }

    if (state.sessionAllowedTools.has(toolName)) {
      return Promise.resolve<PermissionResult>({ behavior: "allow", updatedInput: input })
    }

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

// ── Build SDK query options ──────────────────────────────────────────

function buildQueryOptions(state: SDKSessionState, opts: {
  isResume?: boolean
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
}): Options {
  const isBypass = state.permissionMode === "bypassPermissions"

  // Ultracode requires xhigh effort — override whatever the UI selected so the
  // launched session and its effort label stay consistent with the flag.
  const effort = state.ultracode ? "xhigh" : state.effort

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
    // question bar that swallows input. Regular tools still auto-allow in
    // bypass mode (see makeCanUseTool).
    canUseTool: makeCanUseTool(state),
    effort: effort as Options["effort"],
    enableFileCheckpointing: true,
    persistSession: true,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    // Token-level streaming: raw Anthropic stream events are forwarded to
    // the stream bus so the UI can render text as it is generated.
    includePartialMessages: streamingEnabled(),
    // Forward the full subagent conversation (tagged with parent_tool_use_id)
    // so live subagent transcripts can render under their tool card.
    forwardSubagentText: true,
  }

  if (isBypass) {
    queryOpts.allowDangerouslySkipPermissions = true
  }

  if (opts.isResume) {
    queryOpts.resume = state.sessionId
  } else {
    queryOpts.sessionId = state.sessionId
  }

  const extraArgs: Record<string, string | null> = {}
  if (opts.name) extraArgs.name = opts.name
  if (opts.worktreeName) extraArgs.worktree = opts.worktreeName
  if (Object.keys(extraArgs).length > 0) queryOpts.extraArgs = extraArgs

  if (opts.mcpConfig) {
    try {
      queryOpts.mcpServers = JSON.parse(opts.mcpConfig)
    } catch { /* ignore invalid JSON */ }
  }

  // Ultracode is session-scoped and provided via the `settings` layer (the
  // --settings equivalent). It needs Workflows enabled to function, so we turn
  // that on alongside it.
  if (state.ultracode || state.fastMode) {
    queryOpts.settings = {
      ...(state.ultracode ? { ultracode: true, enableWorkflows: true } : {}),
      ...(state.fastMode ? { fastMode: true } : {}),
    }
  }

  queryOpts.env = { ...process.env }
  delete queryOpts.env.CLAUDECODE

  // Capture the CLI subprocess's stderr so a spawn/exit failure carries its
  // real cause into the error result. Capped to avoid unbounded growth.
  queryOpts.stderr = (data: string) => {
    const next = (state.stderr || "") + data
    state.stderr = next.length > 16_000 ? next.slice(-16_000) : next
  }

  return queryOpts
}

// ── Process SDK events ───────────────────────────────────────────────

function processSDKEvent(state: SDKSessionState, msg: SDKMessage): void {
  if (msg.type === "result") {
    // A result is a turn boundary, not necessarily the end of the SDK query.
    // Background agents/workflows can outlive it, and the persistent input
    // stream remains available for queued follow-up turns.
    state.running = false
    streamBus.clear(state.sessionId)
    state.onResult?.(msg as unknown as Record<string, unknown>)
    state.onResult = null
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
    // Publish them to the bus for the live transcript, and keep them out of
    // pendingTaskCalls — a subagent's nested Task call would corrupt the
    // subagentWatcher's prompt matching.
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

    const blocks = message?.content as Array<{ type: string; name?: string; id?: string; input?: { prompt?: string } }> | undefined
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block.type === "tool_use" && (block.name === "Task" || block.name === "Agent")) {
        state.pendingTaskCalls.set(block.id!, block.input?.prompt ?? "")
      }
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
}): void {
  state.abort = new AbortController()
  state.running = true
  state.stderr = ""

  const queryOpts = buildQueryOptions(state, opts)
  const messageStream = new SDKMessageStream()
  messageStream.enqueue(buildUserMessage(prompt, opts.images))
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
    try {
      for await (const msg of q) {
        processSDKEvent(state, msg)
      }
    } catch (err) {
      if (state.onResult) {
        const base = String(err)
        const detail = state.stderr?.trim()
        // Append captured stderr so the surfaced error is verbose enough to
        // diagnose (the SDK's own message is just "exited with code 1").
        const result = detail && !base.includes(detail) ? `${base}\n\n${detail}` : base
        state.onResult({ type: "result", is_error: true, result })
        state.onResult = null
      }
    } finally {
      messageStream.close()
      state.subagentWatcher?.close()
      state.subagentWatcher = null
      state.running = false
      if (state.messageStream === messageStream) state.messageStream = null
      if (state.activeQuery === q) state.activeQuery = null
      if (state.abort === queryOpts.abortController) state.abort = null
      streamBus.clear(state.sessionId)
      rejectAllPending(state, "Session ended")
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
}

// ── Helper: build an SDKUserMessage from text + optional images ──────

function buildUserMessage(
  message: string,
  images?: ImageAttachment[],
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
}

function initSDKSessionState(opts: SDKSessionInitOpts): SDKSessionState {
  return {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    pendingPermissions: new Map(),
    pendingUserQuestions: new Map(),
    sessionAllowedTools: new Set(),
    running: false,
    abort: null,
    activeQuery: null,
    messageStream: null,
    onResult: null,
    jsonlPath: null,
    pendingTaskCalls: new Map(),
    subagentWatcher: null,
    worktreeName: opts.worktreeName || null,
    permissionMode: opts.permissionMode || "default",
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
// We record them on `state` unconditionally so that any subsequent query
// restart picks up the newest values. When the query is still live we also
// push model/effort changes into the running SDK Query via setModel() and
// applyFlagSettings() — the SDK has no setEffort, but effortLevel in the
// settings layer is the documented way to change reasoning effort
// mid-session.

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
  permissionsChanged: boolean
  mcpConfigChanged: boolean
  nextEffort?: string
}

function applySessionUpdates(
  state: SDKSessionState,
  updates?: SDKSessionUpdates,
): AppliedSessionUpdates {
  const effectiveEffort = (session: SDKSessionState) =>
    session.ultracode ? "xhigh" : session.effort
  const previousEffort = effectiveEffort(state)
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

  const nextEffort = effectiveEffort(state)
  return {
    modelChanged,
    effortChanged: nextEffort !== undefined && nextEffort !== previousEffort,
    fastModeChanged,
    ultracodeChanged,
    permissionModeChanged,
    permissionsChanged,
    mcpConfigChanged,
    nextEffort,
  }
}

async function pushSessionUpdates(
  state: SDKSessionState,
  changes: AppliedSessionUpdates,
): Promise<string[]> {
  const queryHandle = state.activeQuery
  if (!queryHandle) return []

  const applied: string[] = []
  if (changes.modelChanged) {
    await queryHandle.setModel(state.model || undefined)
    applied.push("model")
  }
  if (changes.permissionModeChanged) {
    await queryHandle.setPermissionMode(state.permissionMode as PermissionMode)
    applied.push("permissionMode")
  }

  const flagSettings: Record<string, unknown> = {}
  if (changes.ultracodeChanged) {
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
  // Max is intentionally session-scoped and is not accepted by the persisted
  // effortLevel setting. Keep it staged for the next resumed query instead.
  if (changes.effortChanged && changes.nextEffort && changes.nextEffort !== "max") {
    flagSettings.effortLevel = changes.nextEffort
  }
  if (Object.keys(flagSettings).length > 0) {
    await queryHandle.applyFlagSettings(
      flagSettings as Parameters<Query["applyFlagSettings"]>[0],
    )
    applied.push(...Object.keys(flagSettings))
  }

  if (changes.mcpConfigChanged) {
    try {
      const parsed = state.mcpConfig
        ? JSON.parse(state.mcpConfig) as Record<string, unknown>
        : {}
      await queryHandle.setMcpServers(parsed as Parameters<Query["setMcpServers"]>[0])
      applied.push("mcpConfig")
    } catch {
      // Invalid or provider-managed MCP configuration remains staged for the
      // next query, where the normal SDK option validation will report it.
    }
  }
  return applied
}

// Switching permission mode mid-turn must take effect immediately: approvals
// the user is currently being asked for are re-evaluated under the new mode so
// the turn continues without further clicks. bypassPermissions allows
// everything pending; acceptEdits allows pending file edits.
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

function autoResolvePendingForMode(state: SDKSessionState, changes: AppliedSessionUpdates): void {
  if (!changes.permissionModeChanged) return
  const allowAll = state.permissionMode === "bypassPermissions"
  const allowEdits = state.permissionMode === "acceptEdits"
  if (!allowAll && !allowEdits) return
  for (const [requestId, pending] of [...state.pendingPermissions]) {
    if (!allowAll && !EDIT_TOOL_NAMES.has(pending.toolName)) continue
    state.pendingPermissions.delete(requestId)
    applyDecision(state, pending, "allow")
  }
}

export async function updateSDKSession(
  sessionId: string,
  updates: SDKSessionUpdates,
): Promise<{ found: boolean; appliedLive: string[]; staged: string[] }> {
  const state = sdkSessions.get(sessionId)
  if (!state) return { found: false, appliedLive: [], staged: Object.keys(updates) }
  const changes = applySessionUpdates(state, updates)
  autoResolvePendingForMode(state, changes)
  let appliedLive: string[] = []
  try {
    appliedLive = await pushSessionUpdates(state, changes)
  } catch {
    // The query may finish between checking `running` and sending a control
    // request. State is still updated, so the next resume applies the values.
  }
  return {
    found: true,
    appliedLive,
    staged: Object.keys(updates).filter((key) => !appliedLive.includes(key)),
  }
}

export function sendSDKMessage(
  sessionId: string,
  message: string,
  images?: ImageAttachment[],
  updates?: SDKSessionUpdates,
): SDKSessionState | null {
  const state = sdkSessions.get(sessionId)
  if (!state) return null

  const changes = applySessionUpdates(state, updates)
  autoResolvePendingForMode(state, changes)

  if (state.activeQuery && state.messageStream) {
    const q = state.activeQuery
    const input = buildUserMessage(message, images)
    if (!state.messageStream.enqueue(input)) return null
    state.running = true

    // Fire any setting updates as independent control requests. The SDK
    // delivers them over its own queue; we don't await ordering guarantees
    // here, so in practice a model/effort change may apply to the queued turn
    // or the turn after —
    // whichever the SDK schedules first. Either outcome is acceptable: the
    // setting is persisted on `state` (above) so any subsequent resume also
    // sees the new value. All updates are best-effort; we swallow failures so
    // a single failing control request doesn't break the in-flight turn.
    if (changes.modelChanged) {
      q.setModel(state.model).catch(() => {})
    }
    if (changes.ultracodeChanged) {
      q.applyFlagSettings({
        ultracode: state.ultracode,
        ...(state.ultracode ? { enableWorkflows: true } : {}),
      }).catch(() => {})
    }
    if (changes.fastModeChanged) {
      q.applyFlagSettings({ fastMode: state.fastMode ?? false }).catch(() => {})
    }
    if (changes.effortChanged && changes.nextEffort !== undefined && changes.nextEffort !== "max") {
      q.applyFlagSettings({
        effortLevel: changes.nextEffort as "low" | "medium" | "high" | "xhigh",
      }).catch(() => {})
    }
    if (changes.permissionModeChanged) {
      q.setPermissionMode(state.permissionMode as PermissionMode).catch(() => {})
    }
    return state
  }

  // Session idle — start a new resume query with the freshly-updated state
  runQuery(state, message, { isResume: true, mcpConfig: state.mcpConfig, images })
  return state
}

// ── Resume a dead SDK session (creates fresh state + runs resume query) ──

export function resumeSDKSession(opts: SDKSessionInitOpts): SDKSessionState {
  const state = initSDKSessionState({ ...opts, worktreeName: undefined })
  sdkSessions.set(opts.sessionId, state)
  runQuery(state, opts.message, { isResume: true, mcpConfig: opts.mcpConfig, images: opts.images })
  return state
}

// ── Resolve a single permission request ──────────────────────────────

function applyDecision(
  state: SDKSessionState,
  pending: PendingPermission,
  behavior: PermissionDecision,
): void {
  if (behavior === "deny") {
    pending.resolve({ behavior: "deny", message: "User declined tool execution." })
    return
  }
  if (behavior === "allow_always") {
    if (!pending.suggestions?.length) {
      state.sessionAllowedTools.add(pending.toolName)
    }
  }
  pending.resolve({
    behavior: "allow",
    updatedInput: pending.input,
    ...(behavior === "allow_always" && pending.suggestions?.length
      ? { updatedPermissions: pending.suggestions }
      : {}),
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
  applyDecision(state, pending, behavior)

  return { found: true, toolName: pending.toolName }
}

export type UserQuestionAnswers = Record<string, string> | string[] | string

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

/** Resolve the blocked AskUserQuestion tool with the SDK's expected input shape. */
export function resolveUserQuestion(
  sessionId: string,
  toolUseId: string,
  answers: UserQuestionAnswers,
): { found: boolean } {
  const state = sdkSessions.get(sessionId)
  if (!state) return { found: false }

  const pending = state.pendingUserQuestions.get(toolUseId)
  if (!pending) return { found: false }
  const normalized = normalizeUserQuestionAnswers(pending.input, answers)
  if (!normalized) return { found: false }

  state.pendingUserQuestions.delete(toolUseId)
  pending.resolve({
    behavior: "allow",
    updatedInput: { ...pending.input, answers: normalized },
  })
  return { found: true }
}

// ── Resolve all pending permission requests ──────────────────────────

export function resolveAllPermissions(
  sessionId: string,
  behavior: PermissionDecision,
): string[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []

  const toolNames: string[] = []
  for (const pending of state.pendingPermissions.values()) {
    toolNames.push(pending.toolName)
    applyDecision(state, pending, behavior)
  }
  state.pendingPermissions.clear()

  return [...new Set(toolNames)]
}

// ── Get pending permission requests ──────────────────────────────────

export function getSDKPermissions(sessionId: string): PermissionRequestData[] {
  const state = sdkSessions.get(sessionId)
  if (!state) return []
  return Array.from(state.pendingPermissions.values(), ({ resolve: _, ...rest }) => rest)
}

// ── Stop / cleanup ───────────────────────────────────────────────────

function teardownState(state: SDKSessionState): void {
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
  state.running = false
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
  if (!state?.running || !state.activeQuery) return false
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

  const abort = new AbortController()
  const control = query({
    // eslint-disable-next-line require-yield
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise(() => {})
    })(),
    options: {
      abortController: abort,
      cwd,
      resume: sessionId,
      enableFileCheckpointing: true,
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    },
  })
  try {
    return await control.rewindFiles(userMessageId, { dryRun })
  } finally {
    abort.abort()
    control.close()
  }
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
