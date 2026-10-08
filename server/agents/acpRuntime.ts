import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { publishError, publishAgentProgress } from "../lib/streamBus"
import { resolveAgentCommand } from "../lib/binaryResolver"
import * as acp from "@agentclientprotocol/sdk"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { acpStore } from "./acpStore"
import { AgentRuntimeError, reportSessionId, selectAvailableDecision, resolvedApproval, type AgentRuntime, type PendingApproval, type ApprovalDecision, type SendRequest, type TurnResult } from "./runtimeTypes"

interface LiveSession { nativeId: string; cwd: string; filePath: string; running: boolean; terminalWritten?: boolean; loading?: boolean; completion?: Promise<TurnResult>; configOptions?: acp.SessionConfigOption[] }
interface Permission { approval: PendingApproval; options: acp.PermissionOption[]; resolve: (value: acp.RequestPermissionResponse) => void; timer: ReturnType<typeof setTimeout> }
const descriptor = descriptorFor("acp")
const sessions = new Map<string, LiveSession>()
const permissions = new Map<string, Permission>()
const sending = new Set<string>()
let connection: acp.ClientConnection | undefined
let child: ChildProcessWithoutNullStreams | undefined
let ready: Promise<acp.ClientConnection> | undefined
let initialization: acp.InitializeResponse | undefined
let generation = 0
let requests = 0
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const timer = setTimeout(() => lose(error(504, "ACP request timed out; inspect provider history before retrying")), milliseconds)
  try { return await promise } finally { clearTimeout(timer) }
}
const error = (status: number, message: string) => new AgentRuntimeError(status, "ACP_ERROR", message)
function append(sessionId: string, value: object): void {
  const session = sessions.get(sessionId)
  if (!session) return
  appendFileSync(session.filePath, JSON.stringify({ ...value, sessionId, timestamp: new Date().toISOString(), uuid: randomUUID() }) + "\n", { mode: 0o600 })
}
function finishPrompt(sessionId: string, session: LiveSession, result: string, isError: boolean): void {
  if (sessions.get(sessionId) !== session || session.terminalWritten) return
  session.terminalWritten = true
  append(sessionId, { type: "assistant", message: { role: "assistant", content: [], stop_reason: "end_turn" } })
  append(sessionId, { type: "result", subtype: isError ? "error_during_execution" : "success", result })
}
function lose(cause: unknown): void {
  generation++
  for (const [id, session] of sessions) if (session.running) finishPrompt(id, session, String(cause), true)
  connection?.close(cause)
  connection = undefined
  ready = undefined
  initialization = undefined
  for (const pending of permissions.values()) { clearTimeout(pending.timer); pending.resolve({ outcome: { outcome: "cancelled" } }) }
  permissions.clear()
  sessions.clear()
  child?.kill()
  child = undefined
}
async function connect(): Promise<acp.ClientConnection> {
  if (ready) return ready
  if (connection && !connection.signal.aborted) return connection
  const executable = process.env.COGPIT_PROVIDER_EXECUTABLE
  if (!executable) throw error(400, "Configure an ACP provider instance with its executable first")
  ready = (async () => {
    const currentGeneration = ++generation
    const args: unknown = JSON.parse(process.env.COGPIT_PROVIDER_ARGS || "[]")
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw error(400, "Invalid ACP arguments")
    const command = resolveAgentCommand(executable, args as string[])
    const processChild = spawn(command.command, command.args, { shell: false, ...command.spawnOptions, stdio: ["pipe", "pipe", "pipe"], env: process.env })
    child = processChild
    let stderr = ""
    processChild.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
    processChild.on("error", (cause) => { if (generation === currentGeneration) lose(cause) })
    processChild.on("exit", () => { if (generation === currentGeneration) lose(error(502, stderr || "ACP process disconnected")) })
    const app = acp.client({ name: "cogpit" })
    app.onNotification("session/update", ({ params }) => {
      if (generation !== currentGeneration) return
      const entry = [...sessions].find(([, session]) => session.nativeId === params.sessionId)
      if (!entry) return
      if (entry[1].loading) return
      const [id] = entry
      const update = params.update
      if (update.sessionUpdate === "tool_call_update") publishAgentProgress(id, update.toolCallId, update.title ?? update.status ?? "Working")
      append(id, { type: "acp_update", update })
      if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
        append(id, { type: "assistant", message: { role: "assistant", content: [update.sessionUpdate === "agent_thought_chunk" ? { type: "thinking", thinking: update.content.text } : { type: "text", text: update.content.text }] } })
      }
      if (update.sessionUpdate === "tool_call") append(id, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: update.toolCallId, name: update.title || update.kind || "Tool", input: update.rawInput ?? {} }] } })
      if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) append(id, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: update.toolCallId, content: JSON.stringify(update.rawOutput ?? update.content ?? []), is_error: update.status === "failed" }] } })
    })
    app.onRequest("session/request_permission", ({ params, requestId, signal }) => {
      const entry = [...sessions].find(([, session]) => session.nativeId === params.sessionId)
      if (!entry || generation !== currentGeneration || permissions.size >= 64) return { outcome: { outcome: "cancelled" } }
      const key = `${currentGeneration}:${JSON.stringify(requestId)}`
      const decisions: ApprovalDecision[] = params.options.flatMap((option) => option.kind === "allow_once" ? ["allow" as const] : option.kind === "allow_always" ? ["allow_always" as const] : ["deny" as const])
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        const cancel = () => { const pending = permissions.get(key); if (!pending) return; clearTimeout(pending.timer); permissions.delete(key); resolve({ outcome: { outcome: "cancelled" } }) }
        const timer = setTimeout(cancel, 15 * 60 * 1000)
        timer.unref()
        signal.addEventListener("abort", cancel, { once: true })
        permissions.set(key, { approval: { timestamp: Date.now(), sessionId: entry[0], requestId: key, toolUseId: params.toolCall.toolCallId, toolName: params.toolCall.title || "Tool", input: { value: params.toolCall.rawInput ?? {} }, availableDecisions: [...new Set(decisions)] }, options: params.options, resolve: (value) => { signal.removeEventListener("abort", cancel); resolve(value) }, timer })
      })
    })
    const stream = acp.ndJsonStream(Writable.toWeb(processChild.stdin) as WritableStream<Uint8Array>, Readable.toWeb(processChild.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 1024 * 1024 })
    const connected = app.connect(stream)
    connection = connected
    void connected.closed.then(() => { if (generation === currentGeneration) lose(error(502, "ACP connection closed")) })
    const initialized = await bounded(connected.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "cogpit", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, { cancellationSignal: AbortSignal.timeout(15000) }), 15000)
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw error(502, `Unsupported ACP protocol ${initialized.protocolVersion}`)
    initialization = initialized
    return connected
  })().catch((cause) => { lose(cause); throw cause })
  return ready
}
async function load(id: string, request: SendRequest): Promise<LiveSession> {
  const found = sessions.get(id)
  if (found) return found
  const connected = await connect()
  if (!initialization?.agentCapabilities?.loadSession) throw error(409, "This ACP provider cannot reload sessions. Start an explicit context handoff.")
  const filePath = request.filePath ?? await acpStore.findSessionFile(id)
  if (!filePath) throw error(404, "ACP transcript not found")
  const header = JSON.parse(readFileSync(filePath, "utf8").split("\n", 1)[0]!) as { nativeSessionId?: string; cwd?: string }
  if (!header.nativeSessionId || !header.cwd) throw error(400, "ACP transcript is missing its native binding")
  const session: LiveSession = { nativeId: header.nativeSessionId, cwd: header.cwd, filePath, running: false, loading: true }
  sessions.set(id, session)
  try { const loaded = await bounded(connected.agent.request("session/load", { sessionId: session.nativeId, cwd: session.cwd, mcpServers: [] }, { cancellationSignal: AbortSignal.timeout(30000) }), 30000); session.configOptions = loaded.configOptions ?? undefined; session.loading = false } catch (cause) { sessions.delete(id); throw cause }
  return session
}
async function send(id: string, request: SendRequest) {
  if (sending.has(id)) return { delivery: "busy" as const }
  sending.add(id)
  let started = false
  try {
    const session = await load(id, request)
    if (session.running) return { delivery: "busy" as const }
    if (requests >= 64) throw error(429, "ACP request limit reached")
    if (request.images?.length && !initialization?.agentCapabilities?.promptCapabilities?.image) throw error(400, "This ACP provider does not accept images")
    if (request.effort || request.fastMode || request.ultracode || request.mcpConfig || request.contextWindowTokens || (request.permissions?.mode && !["default", "manual", "auto"].includes(request.permissions.mode)) || request.permissions?.allowedTools?.length || request.permissions?.disallowedTools?.length) throw error(400, "These settings are not supported by this ACP provider")
    if (request.model) {
      const option = session.configOptions?.find((value) => value.category === "model" && value.type === "select")
      if (!option || option.type !== "select" || !selectOptions(option).some((value) => value.value === request.model)) throw error(400, "The ACP provider did not offer this model")
      const result = await bounded(connection!.agent.request("session/set_config_option", { sessionId: session.nativeId, configId: option.id, value: request.model }), 15000)
      session.configOptions = result.configOptions
    }
    session.running = true
    session.terminalWritten = false
    requests++
    append(id, { type: "user", cwd: session.cwd, message: { role: "user", content: request.message ?? "" } })
    const prompt: acp.ContentBlock[] = [{ type: "text", text: request.message ?? "" }, ...(request.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType }))]
    const completion: Promise<TurnResult> = connection!.agent.request("session/prompt", { sessionId: session.nativeId, prompt }).then((response) => {
      finishPrompt(id, session, response.stopReason, response.stopReason === "cancelled")
      return { isError: response.stopReason === "cancelled", message: response.stopReason }
    }, (cause: unknown) => { finishPrompt(id, session, String(cause), true); publishError(id, String(cause)); throw cause }).finally(() => { session.running = false; session.completion = undefined; requests--; sending.delete(id) })
    session.completion = completion
    started = true
    return { delivery: "started" as const, completion }
  } finally { if (!started) sending.delete(id) }
}
function selectOptions(option: acp.SessionConfigOption): acp.SessionConfigSelectOption[] {
  if (option.type !== "select") return []
  return option.options.flatMap((value) => "group" in value ? value.options : [value])
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
export const acpRuntime: AgentRuntime = {
  kind: "acp", descriptor,
  async start(request) {
    const connected = await connect()
    const native = await bounded(connected.agent.request("session/new", { cwd: request.cwd, mcpServers: [] }, { cancellationSignal: AbortSignal.timeout(30000) }), 30000)
    const id = randomUUID()
    const dirName = descriptor.dirName.encode(request.cwd)
    const path = acpStore.transcriptPath(dirName, id)!
    mkdirSync(dirname(path.filePath), { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") chmodSync(dirname(path.filePath), 0o700)
    writeFileSync(path.filePath, JSON.stringify({ type: "acp_session", sessionId: id, nativeSessionId: native.sessionId, cwd: request.cwd, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 })
    sessions.set(id, { nativeId: native.sessionId, cwd: request.cwd, filePath: path.filePath, running: false, configOptions: native.configOptions ?? undefined })
    reportSessionId(request, id)
    if (request.message || request.images?.length) { const outcome = await send(id, request); void outcome.completion?.catch(() => {}) }
    return { sessionId: id, dirName, ...path, initialContent: readFileSync(path.filePath, "utf8") }
  },
  send,
  async interrupt(id) {
    const session = sessions.get(id)
    if (!session?.running || !connection) return false
    await connection.agent.notify("session/cancel", { sessionId: session.nativeId })
    if (session.completion) await bounded(session.completion, 15000)
    return true
  },
  async stop(id) { if (!sessions.has(id)) return false; await this.interrupt(id); sessions.delete(id); for (const [key, pending] of permissions) if (pending.approval.sessionId === id) { clearTimeout(pending.timer); pending.resolve({ outcome: { outcome: "cancelled" } }); permissions.delete(key) }; return true },
  async stopAll() { const ids = [...sessions.keys()]; for (const id of ids) await this.stop(id); return { stopped: ids.length, failed: 0 } },
  async deleteSession(id, filePath) { await this.stop(id); if (!acpStore.ownsPath(filePath)) throw error(403, "Transcript is outside this provider instance"); rmSync(filePath, { force: true }) },
  activity: (id) => ({ live: sessions.has(id) && Boolean(connection && !connection.signal.aborted), running: sessions.get(id)?.running ?? false }),
  hasSession: (id) => sessions.has(id), listActive: () => [...sessions].filter(([, value]) => value.running).map(([sessionId]) => ({ sessionId })),
  listPendingApprovals: (id) => [...permissions.values()].map((value) => value.approval).filter((value) => !id || value.sessionId === id),
  respondToApproval: respond,
  async respondToAllApprovals(id, decision) { const values = this.listPendingApprovals(id); for (const value of values) if (!selectAvailableDecision(value.availableDecisions, decision)) throw error(400, "Permission decision is unavailable"); const resolved = []; for (const value of values) if (await respond(id, value.requestId, decision)) resolved.push(resolvedApproval(value)); return resolved },
  listPendingQuestions: () => [], answerQuestion: async () => null,
  async describeRuntime() { await connect(); return initialization },
  async listModels() { const model = [...sessions.values()].flatMap((session) => session.configOptions ?? []).find((option) => option.category === "model" && option.type === "select"); return model ? [{ value: "", label: "Provider default", supportsEffort: false }, ...selectOptions(model).map((option) => ({ value: option.value, label: option.name, supportsEffort: false }))] : null },
  liveUsageRecords: async () => [], fork: async () => { throw error(400, "ACP native fork is unsupported") },
  async shutdown() { lose(error(503, "ACP runtime stopped")) },
}
