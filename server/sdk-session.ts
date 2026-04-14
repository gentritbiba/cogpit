import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  Options,
  SDKMessage,
  CanUseTool,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk"

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

export interface SDKSessionState {
  sessionId: string
  cwd: string
  /** Permission requests awaiting user decision — canUseTool is blocked on the `resolve` promise */
  pendingPermissions: Map<string, PendingPermission>
  /** Tools the user approved "always for this session" — canUseTool auto-allows these */
  sessionAllowedTools: Set<string>
  running: boolean
  abort: AbortController | null
  onResult: ((msg: Record<string, unknown>) => void) | null
  jsonlPath: string | null
  pendingTaskCalls: Map<string, string>
  worktreeName: string | null
  permissionMode: string
  allowedTools: string[]
  disallowedTools: string[]
  model?: string
  effort?: string
  mcpConfig?: string | null
}

export const sdkSessions = new Map<string, SDKSessionState>()

// ── canUseTool: block until the user resolves the request ───────────────
// The SDK awaits this callback, so we can simply return a Promise that
// resolves once the UI (via resolvePermission / resolveAllPermissions)
// decides. No deny+interrupt+resume dance, no process kill, no retries.

function makeCanUseTool(state: SDKSessionState): CanUseTool {
  return (toolName, input, options) => {
    // Session-scoped always-allow: short-circuit without queueing the UI
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

  return queryOpts
}

// ── Process SDK events ───────────────────────────────────────────────

function processSDKEvent(state: SDKSessionState, msg: SDKMessage): void {
  if (msg.type === "result") {
    state.running = false
    state.onResult?.(msg as unknown as Record<string, unknown>)
    state.onResult = null
  }

  if (msg.type === "assistant") {
    const message = (msg as Record<string, unknown>).message as { content?: unknown[] } | undefined
    const blocks = message?.content as Array<{ type: string; name?: string; id?: string; input?: { prompt?: string } }> | undefined
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block.type === "tool_use" && (block.name === "Task" || block.name === "Agent")) {
        state.pendingTaskCalls.set(block.id!, block.input?.prompt ?? "")
      }
    }
  }
}

// ── Run a query and iterate in background ────────────────────────────

function runQuery(state: SDKSessionState, prompt: string, opts: {
  isResume?: boolean
  name?: string
  worktreeName?: string
  mcpConfig?: string | null
}): void {
  state.abort = new AbortController()
  state.running = true

  const queryOpts = buildQueryOptions(state, opts)
  const q = query({ prompt, options: queryOpts })

  ;(async () => {
    try {
      for await (const msg of q) {
        processSDKEvent(state, msg)
      }
    } catch (err) {
      if (state.onResult) {
        state.onResult({ type: "result", is_error: true, result: String(err) })
        state.onResult = null
      }
    } finally {
      state.running = false
      state.abort = null
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

// ── Create a new SDK session ─────────────────────────────────────────

interface SDKSessionInitOpts {
  sessionId: string
  cwd: string
  message: string
  images?: Array<{ data: string; mediaType: string }>
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
    onResult: null,
    jsonlPath: null,
    pendingTaskCalls: new Map(),
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
  })
  return state
}

// ── Send a follow-up message (resumes with current allowedTools) ─────

export function sendSDKMessage(
  sessionId: string,
  message: string,
  _images?: Array<{ data: string; mediaType: string }>,
): SDKSessionState | null {
  const state = sdkSessions.get(sessionId)
  if (!state || state.running) return null

  runQuery(state, message, { isResume: true, mcpConfig: state.mcpConfig })
  return state
}

// ── Resume a dead SDK session (creates fresh state + runs resume query) ──

export function resumeSDKSession(opts: SDKSessionInitOpts): SDKSessionState {
  const state = initSDKSessionState({ ...opts, worktreeName: undefined })
  sdkSessions.set(opts.sessionId, state)
  runQuery(state, opts.message, { isResume: true, mcpConfig: opts.mcpConfig })
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

export function stopSDKSession(sessionId: string): boolean {
  const state = sdkSessions.get(sessionId)
  if (!state) return false

  rejectAllPending(state, "Session stopped")
  state.abort?.abort()
  state.running = false
  sdkSessions.delete(sessionId)
  return true
}

export function cleanupAllSDKSessions(): number {
  let killed = 0
  for (const state of sdkSessions.values()) {
    rejectAllPending(state, "Session stopped")
    if (state.abort) {
      state.abort.abort()
      killed++
    }
    state.running = false
  }
  sdkSessions.clear()
  return killed
}
