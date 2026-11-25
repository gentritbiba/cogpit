import { isSessionStarting } from "./runtimeTypes"
import { beforeFirstTurn } from "./startup"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { publishError, publishAgentProgress } from "../lib/streamBus"
import { resolveAgentCommand } from "../lib/binaryResolver"
import * as acp from "@agentclientprotocol/sdk"
import { descriptorFor, type AgentKind, type ModelOption } from "../../shared/session/agent-descriptors"
import { acpStore } from "./acpStore"
import type { AgentStore } from "./types"
import { pluginSkillContext } from "../plugins/skillContext"
import { AgentRuntimeError, reportSessionId, selectAvailableDecision, resolvedApproval, type AgentRuntime, type PendingApproval, type PendingQuestion, type ApprovalDecision, type SendRequest, type TurnResult } from "./runtimeTypes"

/** How to start an ACP agent's process. */
export interface AcpLaunch { command: string; args: string[]; env: NodeJS.ProcessEnv }

/** A config option to set before a prompt: the first option in `category`, set to `value`. */
export interface AcpTurnSetting { category: string; value: string; required: boolean }

/** What the agent asked to do, as the transcript records it. */
export interface AcpToolUse { name: string; input: Record<string, unknown> }

/** How a permission request is handled without asking the person. */
export type AcpPermissionRoute = "ask" | "question" | { optionKind: acp.PermissionOptionKind }

/**
 * Everything that differs between ACP agents. The runtime itself, its process,
 * sessions, transcripts and approvals, is shared.
 */
export interface AcpProfile {
  kind: AgentKind
  store: AgentStore
  /** Product name for error messages. */
  label: string
  /** First transcript record's `type`, which tells this agent's transcripts apart. */
  headerType: string
  /** Session ids are the agent's own, so its CLI can resume them; otherwise Cogpit mints one. */
  nativeSessionIds: boolean
  launch(): AcpLaunch
  checkInitialize?(response: acp.InitializeResponse): void
  /** Config options this turn needs; throws for settings the agent cannot honour. */
  turnSettings(request: SendRequest): AcpTurnSetting[]
  routePermission?(request: acp.RequestPermissionRequest, mode: string | undefined): AcpPermissionRoute
  toolUse?(toolCall: AcpToolCallState): AcpToolUse
  /** The result text of a finished call, when the agent puts it somewhere other than its content. */
  toolResult?(toolCall: AcpToolCallState): string | undefined
  /** Turns an ACP error into the message the person should see, or null to keep it. */
  explainError?(cause: unknown): AgentRuntimeError | null
}

/** A tool call as its updates have filled it in so far. */
export interface AcpToolCallState {
  toolCallId: string
  title?: string | null
  kind?: acp.ToolKind | null
  rawInput?: unknown
  rawOutput?: unknown
  content?: acp.ToolCallContent[] | null
  locations?: acp.ToolCallLocation[] | null
  written?: boolean
}

interface LiveSession { nativeId: string; cwd: string; filePath: string; running: boolean; terminalWritten?: boolean; loading?: boolean; preparing?: AbortController; completion?: Promise<TurnResult>; configOptions?: acp.SessionConfigOption[]; mode?: string; tools: Map<string, AcpToolCallState> }
interface Permission { approval: PendingApproval; options: acp.PermissionOption[]; resolve: (value: acp.RequestPermissionResponse) => void; timer: ReturnType<typeof setTimeout> }
interface Question { question: PendingQuestion; options: acp.PermissionOption[]; resolve: (value: acp.RequestPermissionResponse) => void; timer: ReturnType<typeof setTimeout> }

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000
const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } }

export function selectOptions(option: acp.SessionConfigOption): acp.SessionConfigSelectOption[] {
  if (option.type !== "select") return []
  return option.options.flatMap((value) => "group" in value ? value.options : [value])
}

const defaultToolUse = (tool: AcpToolCallState): AcpToolUse => ({ name: tool.title || tool.kind || "Tool", input: (tool.rawInput ?? {}) as Record<string, unknown> })

export function createAcpRuntime(profile: AcpProfile): AgentRuntime {
  const descriptor = descriptorFor(profile.kind)
  const store = profile.store
  const toolUse = profile.toolUse ?? defaultToolUse
  const sessions = new Map<string, LiveSession>()
  const permissions = new Map<string, Permission>()
  const questions = new Map<string, Question>()
  const sending = new Set<string>()
  let connection: acp.ClientConnection | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let ready: Promise<acp.ClientConnection> | undefined
  let initialization: acp.InitializeResponse | undefined
  let generation = 0
  let requests = 0
  const error = (status: number, message: string) => new AgentRuntimeError(status, "ACP_ERROR", message)
  const explained = (cause: unknown) => profile.explainError?.(cause) ?? cause
  async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    const timer = setTimeout(() => lose(error(504, `${profile.label} request timed out; inspect provider history before retrying`)), milliseconds)
    try { return await promise } catch (cause) { throw explained(cause) } finally { clearTimeout(timer) }
  }
  function append(sessionId: string, value: object): void {
    const session = sessions.get(sessionId)
    if (!session) return
    appendFileSync(session.filePath, JSON.stringify({ ...value, sessionId, timestamp: new Date().toISOString(), uuid: randomUUID() }) + "\n", { mode: 0o600 })
  }
  function finishPrompt(sessionId: string, session: LiveSession, result: string, isError: boolean, usage?: acp.Usage | null): void {
    if (sessions.get(sessionId) !== session || session.terminalWritten) return
    session.terminalWritten = true
    append(sessionId, { type: "assistant", message: { role: "assistant", content: [], stop_reason: "end_turn", ...usage ? { usage: claudeUsage(usage) } : {} } })
    append(sessionId, { type: "result", subtype: isError ? "error_during_execution" : "success", result })
  }
  function cancelPending(sessionId?: string): void {
    for (const [key, pending] of [...permissions, ...questions]) {
      const owner = "approval" in pending ? pending.approval.sessionId : pending.question.sessionId
      if (sessionId && owner !== sessionId) continue
      clearTimeout(pending.timer); pending.resolve(CANCELLED); permissions.delete(key); questions.delete(key)
    }
  }
  function lose(cause: unknown): void {
    generation++
    for (const [id, session] of sessions) if (session.running) finishPrompt(id, session, String(cause), true)
    connection?.close(cause)
    connection = undefined
    ready = undefined
    initialization = undefined
    cancelPending()
    sessions.clear()
    child?.kill()
    child = undefined
  }
  function writeTool(id: string, session: LiveSession, tool: AcpToolCallState): void {
    if (tool.written) return
    tool.written = true
    const use = toolUse(tool)
    append(id, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: tool.toolCallId, name: use.name, input: use.input }] } })
    session.tools.set(tool.toolCallId, tool)
  }
  function onUpdate(id: string, session: LiveSession, update: acp.SessionUpdate): void {
    append(id, { type: "acp_update", update })
    if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
      append(id, { type: "assistant", message: { role: "assistant", content: [update.sessionUpdate === "agent_thought_chunk" ? { type: "thinking", thinking: update.content.text } : { type: "text", text: update.content.text }] } })
      return
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return
    const known = session.tools.get(update.toolCallId)
    const tool: AcpToolCallState = { ...known, toolCallId: update.toolCallId }
    for (const key of ["title", "kind", "rawInput", "rawOutput", "content", "locations"] as const) if (update[key] !== undefined && update[key] !== null) (tool as unknown as Record<string, unknown>)[key] = update[key]
    session.tools.set(update.toolCallId, tool)
    if (update.sessionUpdate === "tool_call_update") publishAgentProgress(id, update.toolCallId, update.title ?? update.status ?? "Working")
    const done = update.status === "completed" || update.status === "failed"
    if (done || tool.rawInput !== undefined) writeTool(id, session, tool)
    if (done) {
      session.tools.delete(update.toolCallId)
      append(id, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: update.toolCallId, content: profile.toolResult?.(tool) ?? toolResultText(tool), is_error: update.status === "failed" }] } })
    }
  }
  function sessionFor(nativeId: string, currentGeneration: number): [string, LiveSession] | undefined {
    if (generation !== currentGeneration) return undefined
    return [...sessions].find(([, session]) => session.nativeId === nativeId)
  }
  function onPermission(entry: [string, LiveSession], params: acp.RequestPermissionRequest, key: string, signal: AbortSignal): acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> {
    const [sessionId, session] = entry
    const route = profile.routePermission?.(params, session.mode) ?? "ask"
    if (typeof route === "object") {
      const option = params.options.find((value) => value.kind === route.optionKind)
      if (option) return { outcome: { outcome: "selected", optionId: option.optionId } }
    }
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const cancel = () => {
        const pending = permissions.get(key) ?? questions.get(key)
        if (!pending) return
        clearTimeout(pending.timer); permissions.delete(key); questions.delete(key); resolve(CANCELLED)
      }
      const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS)
      timer.unref()
      signal.addEventListener("abort", cancel, { once: true })
      const settle = (value: acp.RequestPermissionResponse) => { signal.removeEventListener("abort", cancel); resolve(value) }
      if (route === "question") {
        const question: PendingQuestion = { sessionId, toolUseId: key, askedAt: Date.now(), questions: [{ question: params.toolCall.title || "Choose an option", multiSelect: false, options: params.options.map((option) => ({ label: option.name, hasPreview: false })) }] }
        questions.set(key, { question, options: params.options, resolve: settle, timer })
        return
      }
      const decisions: ApprovalDecision[] = params.options.flatMap((option) => option.kind === "allow_once" ? ["allow" as const] : option.kind === "allow_always" ? ["allow_always" as const] : ["deny" as const])
      const tool = session.tools.get(params.toolCall.toolCallId)
      const use = toolUse({ ...tool, ...params.toolCall, title: params.toolCall.title ?? tool?.title, rawInput: params.toolCall.rawInput ?? tool?.rawInput })
      permissions.set(key, { approval: { timestamp: Date.now(), sessionId, requestId: key, toolUseId: params.toolCall.toolCallId, toolName: use.name, input: use.input, availableDecisions: [...new Set(decisions)] }, options: params.options, resolve: settle, timer })
    })
  }
  async function connect(): Promise<acp.ClientConnection> {
    if (ready) return ready
    if (connection && !connection.signal.aborted) return connection
    ready = (async () => {
      const currentGeneration = ++generation
      const launch = profile.launch()
      const command = resolveAgentCommand(launch.command, launch.args, { env: launch.env })
      const processChild = spawn(command.command, command.args, { shell: false, ...command.spawnOptions, stdio: ["pipe", "pipe", "pipe"], env: launch.env })
      child = processChild
      let stderr = ""
      processChild.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
      processChild.on("error", (cause) => { if (generation === currentGeneration) lose(cause) })
      processChild.on("exit", () => { if (generation === currentGeneration) lose(error(502, stderr || `${profile.label} process disconnected`)) })
      const app = acp.client({ name: "cogpit" })
      app.onNotification("session/update", ({ params }) => {
        const entry = sessionFor(params.sessionId, currentGeneration)
        if (!entry || entry[1].loading) return
        onUpdate(entry[0], entry[1], params.update)
      })
      app.onRequest("session/request_permission", ({ params, requestId, signal }) => {
        const entry = sessionFor(params.sessionId, currentGeneration)
        if (!entry || permissions.size + questions.size >= 64) return CANCELLED
        return onPermission(entry, params, `${currentGeneration}:${JSON.stringify(requestId)}`, signal)
      })
      const stream = acp.ndJsonStream(Writable.toWeb(processChild.stdin) as WritableStream<Uint8Array>, Readable.toWeb(processChild.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 16 * 1024 * 1024 })
      const connected = app.connect(stream)
      connection = connected
      void connected.closed.then(() => { if (generation === currentGeneration) lose(error(502, `${profile.label} connection closed`)) })
      const initialized = await bounded(connected.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "cogpit", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, { cancellationSignal: AbortSignal.timeout(90000) }), 90000)
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw error(502, `Unsupported ACP protocol ${initialized.protocolVersion}`)
      profile.checkInitialize?.(initialized)
      initialization = initialized
      return connected
    })().catch((cause) => { lose(cause); throw explained(cause) })
    return ready
  }
  async function load(id: string, request: SendRequest): Promise<LiveSession> {
    const found = sessions.get(id)
    if (found) return found
    const connected = await connect()
    const resume = Boolean(initialization?.agentCapabilities?.sessionCapabilities?.resume)
    if (!resume && !initialization?.agentCapabilities?.loadSession) throw error(409, `${profile.label} cannot reload sessions. Start an explicit context handoff.`)
    const filePath = request.filePath ?? await store.findSessionFile(id)
    if (!filePath) throw error(404, `${profile.label} transcript not found`)
    const header = JSON.parse(readFileSync(filePath, "utf8").split("\n", 1)[0]!) as { nativeSessionId?: string; cwd?: string }
    if (!header.nativeSessionId || !header.cwd) throw error(400, `${profile.label} transcript is missing its native binding`)
    const session: LiveSession = { nativeId: header.nativeSessionId, cwd: header.cwd, filePath, running: false, loading: true, tools: new Map() }
    sessions.set(id, session)
    try {
      const params = { sessionId: session.nativeId, cwd: session.cwd, mcpServers: [] }
      const options = { cancellationSignal: AbortSignal.timeout(90000) }
      const loaded: acp.ResumeSessionResponse | acp.LoadSessionResponse = await bounded(resume ? connected.agent.request("session/resume", params, options) : connected.agent.request("session/load", params, options), 90000)
      session.configOptions = loaded.configOptions ?? undefined
      session.loading = false
    } catch (cause) { sessions.delete(id); throw cause }
    return session
  }
  async function applySettings(session: LiveSession, settings: AcpTurnSetting[]): Promise<void> {
    for (const setting of settings) {
      const option = session.configOptions?.find((value) => value.category === setting.category && value.type === "select")
      const offered = option ? selectOptions(option).some((value) => value.value === setting.value) : false
      if (!option || !offered) {
        if (setting.required) throw error(400, `${profile.label} did not offer ${setting.category === "model" ? "this model" : `the ${setting.category} "${setting.value}"`}`)
        continue
      }
      if (option.currentValue === setting.value) continue
      const result = await bounded(connection!.agent.request("session/set_config_option", { sessionId: session.nativeId, configId: option.id, value: setting.value }), 15000)
      session.configOptions = result.configOptions
    }
  }
  async function send(id: string, request: SendRequest) {
    if (isSessionStarting(id)) return { delivery: "busy" as const }
    if (request.onlyWhileRunning) return { delivery: "busy" as const }
    if (sending.has(id)) return { delivery: "busy" as const }
    sending.add(id)
    let started = false
    let preparation: { session: LiveSession; abort: AbortController } | undefined
    try {
      const session = await load(id, request)
      if (session.running) return { delivery: "busy" as const }
      if (requests >= 64) throw error(429, `${profile.label} request limit reached`)
      if (request.images?.length && !initialization?.agentCapabilities?.promptCapabilities?.image) throw error(400, `${profile.label} does not accept images`)
      const settings = profile.turnSettings(request)
      const abort = new AbortController()
      preparation = { session, abort }
      session.preparing = abort; session.running = true; session.terminalWritten = true
      if (request.permissions?.mode) session.mode = request.permissions.mode
      await applySettings(session, settings)
      if (abort.signal.aborted || sessions.get(id) !== session || !connection) return { delivery: "busy" as const }
      const instructions = await pluginSkillContext(session.cwd)
      if (abort.signal.aborted || sessions.get(id) !== session || !connection) return { delivery: "busy" as const }
      if (requests >= 64) throw error(429, `${profile.label} request limit reached`)
      session.preparing = undefined; preparation = undefined
      session.terminalWritten = false
      requests++
      append(id, { type: "user", cwd: session.cwd, message: { role: "user", content: request.message ?? "" } })
      const prompt: acp.ContentBlock[] = [...instructions ? [{ type: "text" as const, text: instructions }] : [], { type: "text", text: request.message ?? "" }, ...(request.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType }))]
      const completion: Promise<TurnResult> = connection!.agent.request("session/prompt", { sessionId: session.nativeId, prompt }).then((response) => {
        finishPrompt(id, session, response.stopReason, response.stopReason === "cancelled", response.usage)
        return { isError: response.stopReason === "cancelled", message: response.stopReason }
      }, (raw: unknown) => { const cause = explained(raw); finishPrompt(id, session, String(cause), true); publishError(id, String(cause)); throw cause }).finally(() => { session.running = false; session.completion = undefined; requests--; sending.delete(id) })
      session.completion = completion
      started = true
      return { delivery: "started" as const, completion }
    } finally {
      if (!started) {
        if (preparation && preparation.session.preparing === preparation.abort) { preparation.session.preparing = undefined; preparation.session.running = false }
        sending.delete(id)
      }
    }
  }
  async function respond(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = permissions.get(requestId)
    if (!pending || pending.approval.sessionId !== sessionId) return false
    const selected = selectAvailableDecision(pending.approval.availableDecisions, decision)
    if (!selected) throw error(400, "Permission decision is unavailable")
    const option = pending.options.find((value) => selected === "allow" ? value.kind === "allow_once" : selected === "allow_always" ? value.kind === "allow_always" : value.kind === "reject_once" || value.kind === "reject_always")
    if (!option) return false
    permissions.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
    return true
  }
  async function start(request: Parameters<AgentRuntime["start"]>[0]) {
    request.signal?.throwIfAborted()
    const connected = await connect()
    const native = await bounded(connected.agent.request("session/new", { cwd: request.cwd, mcpServers: [] }, { cancellationSignal: AbortSignal.timeout(90000) }), 90000)
    const id = profile.nativeSessionIds ? native.sessionId : randomUUID()
    const dirName = descriptor.dirName.encode(request.cwd)
    const path = store.transcriptPath(dirName, id)!
    mkdirSync(dirname(path.filePath), { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") chmodSync(dirname(path.filePath), 0o700)
    writeFileSync(path.filePath, JSON.stringify({ type: profile.headerType, sessionId: id, nativeSessionId: native.sessionId, cwd: request.cwd, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 })
    sessions.set(id, { nativeId: native.sessionId, cwd: request.cwd, filePath: path.filePath, running: false, configOptions: native.configOptions ?? undefined, tools: new Map() })
    reportSessionId(request, id)
    try { await beforeFirstTurn(request, { sessionId: id, cwd: request.cwd }) } catch (error) { sessions.delete(id); throw error }
    if (request.message || request.images?.length) { const outcome = await send(id, request); void outcome.completion?.catch(() => {}) }
    return { sessionId: id, dirName, cwd: request.cwd, ...path, initialContent: readFileSync(path.filePath, "utf8") }
  }
  const runtime: AgentRuntime = {
    kind: profile.kind, descriptor,
    start,
    send,
    async interrupt(id) {
      const session = sessions.get(id)
      session?.preparing?.abort()
      if (!session?.running || !connection) return false
      await connection.agent.notify("session/cancel", { sessionId: session.nativeId })
      if (session.completion) await bounded(session.completion, 15000)
      return true
    },
    async stop(id) { if (!sessions.has(id)) return false; await runtime.interrupt(id); sessions.delete(id); cancelPending(id); return true },
    async stopAll() { const ids = [...sessions.keys()]; for (const id of ids) await runtime.stop(id); return { stopped: ids.length, failed: 0 } },
    async deleteSession(id, filePath) { await runtime.stop(id); if (!store.ownsPath(filePath)) throw error(403, "Transcript is outside this provider instance"); rmSync(filePath, { force: true }) },
    activity: (id) => ({ live: sessions.has(id) && Boolean(connection && !connection.signal.aborted), running: sessions.get(id)?.running ?? false, agentsRunning: false }),
    hasSession: (id) => sessions.has(id), listActive: () => [...sessions].filter(([, value]) => value.running).map(([sessionId]) => ({ sessionId })),
    listPendingApprovals: (id) => [...permissions.values()].map((value) => value.approval).filter((value) => !id || value.sessionId === id),
    respondToApproval: respond,
    async respondToAllApprovals(id, decision) { const values = runtime.listPendingApprovals(id); for (const value of values) if (!selectAvailableDecision(value.availableDecisions, decision)) throw error(400, "Permission decision is unavailable"); const resolved = []; for (const value of values) if (await respond(id, value.requestId, decision)) resolved.push(resolvedApproval(value)); return resolved },
    listPendingQuestions: (id) => [...questions.values()].map((value) => value.question).filter((value) => !id || value.sessionId === id),
    async answerQuestion(sessionId, questionId, answers) {
      const pending = questions.get(questionId)
      if (!pending || pending.question.sessionId !== sessionId) return null
      const label = typeof answers === "string" ? answers : Array.isArray(answers) ? answers[0] : Object.values(answers)[0]
      const option = pending.options.find((value) => value.name === label)
      if (!option) throw new AgentRuntimeError(400, "INVALID_REQUEST", "Choose one of the offered options")
      questions.delete(questionId)
      clearTimeout(pending.timer)
      pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
      return { message: null }
    },
    async describeRuntime() { await connect(); return initialization },
    async listModels() {
      const options = [...sessions.values()].find((session) => session.configOptions?.some((option) => option.category === "model"))?.configOptions ?? []
      const model = options.find((option) => option.category === "model" && option.type === "select")
      if (!model) return null
      // Thinking levels are reported for the selected model only, so no other model claims them.
      const thought = options.find((option) => option.category === "thought_level" && option.type === "select")
      const efforts = thought ? selectOptions(thought).map((option) => ({ value: option.value, label: option.name })) : []
      return [{ value: "", label: "Provider default", supportsEffort: false }, ...selectOptions(model).map((option): ModelOption => option.value === model.currentValue && efforts.length
        ? { value: option.value, label: option.name, supportsEffort: true, supportedReasoningEfforts: efforts, defaultReasoningEffort: String(thought!.currentValue) }
        : { value: option.value, label: option.name, supportsEffort: false })]
    },
    liveUsageRecords: async () => [], fork: async () => { throw error(400, `${profile.label} native fork is unsupported`) },
    async shutdown() { lose(error(503, `${profile.label} runtime stopped`)) },
  }
  return runtime
}

function claudeUsage(usage: acp.Usage) {
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedReadTokens ?? 0, cache_creation_input_tokens: usage.cachedWriteTokens ?? 0 }
}

function toolResultText(tool: AcpToolCallState): string {
  const text = (tool.content ?? []).flatMap((block) => block.type === "content" && block.content.type === "text" ? [block.content.text] : [])
  if (text.length) return text.join("\n")
  if (typeof tool.rawOutput === "string") return tool.rawOutput
  return JSON.stringify(tool.rawOutput ?? tool.content ?? [])
}

const GENERIC_MODES = new Set(["default", "manual", "auto"])

export const acpRuntime = createAcpRuntime({
  kind: "acp", store: acpStore, label: "ACP provider", headerType: "acp_session", nativeSessionIds: false,
  launch() {
    const executable = process.env.COGPIT_PROVIDER_EXECUTABLE
    if (!executable) throw new AgentRuntimeError(400, "ACP_ERROR", "Configure an ACP provider instance with its executable first")
    const args: unknown = JSON.parse(process.env.COGPIT_PROVIDER_ARGS || "[]")
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new AgentRuntimeError(400, "ACP_ERROR", "Invalid ACP arguments")
    return { command: executable, args: args as string[], env: process.env }
  },
  turnSettings(request) {
    if (request.effort || request.fastMode || request.ultracode || request.mcpConfig || request.contextWindowTokens || (request.permissions?.mode && !GENERIC_MODES.has(request.permissions.mode)) || request.permissions?.allowedTools?.length || request.permissions?.disallowedTools?.length) throw new AgentRuntimeError(400, "ACP_ERROR", "These settings are not supported by this ACP provider")
    return request.model ? [{ category: "model", value: request.model, required: true }] : []
  },
})
