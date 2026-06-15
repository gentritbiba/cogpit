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

export type PermissionDecision = "allow" | "allow_always" | "deny"

export type ImageAttachment = { data: string; mediaType: string }

export interface SDKSessionState {
  sessionId: string
  cwd: string
  /** Permission requests awaiting user decision — canUseTool is blocked on the `resolve` promise */
  pendingPermissions: Map<string, PendingPermission>
  /** Tools the user approved "always for this session" — canUseTool auto-allows these */
  sessionAllowedTools: Set<string>
  running: boolean
  abort: AbortController | null
  /** The live SDK Query handle — kept alive so we can call streamInput() mid-turn */
  activeQuery: Query | null
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
  mcpConfig?: string | null
  /** stderr captured from the Claude CLI subprocess for the current run —
   *  surfaced in the error result so failures show the real reason (e.g. a
   *  missing native binary or glibc mismatch) instead of "exited with code 1". */
  stderr?: string
}

export const sdkSessions = new Map<string, SDKSessionState>()

// ── Attach the sub-agent file watcher once the JSONL path is known ──

export function attachSubagentWatcher(state: SDKSessionState): void {
  if (state.subagentWatcher || !state.jsonlPath) return
  state.subagentWatcher = watchSubagents(
    state.jsonlPath,
    state.sessionId,
    state.pendingTaskCalls,
  )
}

// ── canUseTool: block until the user resolves the request ───────────────

function makeCanUseTool(state: SDKSessionState): CanUseTool {
  return (toolName, input, options) => {
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

  const queryOpts: Options = {
    abortController: state.abort!,
    cwd: state.cwd,
    model: state.model,
    permissionMode: (state.permissionMode || "default") as PermissionMode,
    allowedTools: state.allowedTools.length > 0 ? state.allowedTools : undefined,
    disallowedTools: state.disallowedTools.length > 0 ? state.disallowedTools : undefined,
    canUseTool: isBypass ? undefined : makeCanUseTool(state),
    effort: state.effort as Options["effort"],
    persistSession: true,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    // Token-level streaming: raw Anthropic stream events are forwarded to
    // the stream bus so the UI can render text as it is generated.
    includePartialMessages: true,
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
    state.running = false
    state.activeQuery = null
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

/** Wrap a single SDKUserMessage into an AsyncIterable the SDK accepts as a prompt. */
async function* singleMessageIterable(msg: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield msg
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

  // Use an AsyncIterable<SDKUserMessage> prompt when images are present
  // so multimodal content reaches the API instead of being dropped.
  const queryPrompt = opts.images?.length
    ? singleMessageIterable(buildUserMessage(prompt, opts.images))
    : prompt

  const q = query({ prompt: queryPrompt, options: queryOpts })
  state.activeQuery = q

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
      state.running = false
      state.activeQuery = null
      state.abort = null
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
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
}

function initSDKSessionState(opts: SDKSessionInitOpts): SDKSessionState {
  return {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    pendingPermissions: new Map(),
    sessionAllowedTools: new Set(),
    running: false,
    abort: null,
    activeQuery: null,
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
  mcpConfig?: string | null
}

export function sendSDKMessage(
  sessionId: string,
  message: string,
  images?: ImageAttachment[],
  updates?: SDKSessionUpdates,
): SDKSessionState | null {
  const state = sdkSessions.get(sessionId)
  if (!state) return null

  const modelChanged = updates?.model !== undefined && updates.model !== state.model
  const effortChanged = updates?.effort !== undefined && updates.effort !== state.effort

  if (updates) {
    if (updates.model !== undefined) state.model = updates.model
    if (updates.effort !== undefined) state.effort = updates.effort
    if (updates.mcpConfig !== undefined) state.mcpConfig = updates.mcpConfig
  }

  if (state.running && state.activeQuery) {
    const q = state.activeQuery
    // Fire the message plus any setting updates as three independent control
    // requests. The SDK delivers them over its own queue; we don't await
    // ordering guarantees here, so in practice the model/effort change may
    // apply to the turn this message kicks off *or* the turn after —
    // whichever the SDK schedules first. Either outcome is acceptable: the
    // setting is persisted on `state` (above) so any subsequent resume also
    // sees the new value. All three are best-effort; we swallow failures so
    // a single failing control request doesn't break the in-flight turn.
    const input = singleMessageIterable(buildUserMessage(message, images))
    q.streamInput(input).catch(() => {
      // streamInput can fail if the query finished between our check and the call
    })
    if (modelChanged && state.model !== undefined) {
      q.setModel(state.model).catch(() => {})
    }
    if (effortChanged && state.effort !== undefined) {
      q.applyFlagSettings({
        effortLevel: state.effort as "low" | "medium" | "high" | "xhigh",
      }).catch(() => {})
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
    state.sessionAllowedTools.add(pending.toolName)
  }
  pending.resolve({ behavior: "allow", updatedInput: pending.input })
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

export function cleanupAllSDKSessions(): number {
  let killed = 0
  for (const state of sdkSessions.values()) {
    teardownState(state)
    if (state.abort) killed++
  }
  sdkSessions.clear()
  return killed
}
