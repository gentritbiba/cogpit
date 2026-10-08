import { nativeBinding } from "../agents/nativeBindings"
import type { IncomingMessage } from "node:http"
import { readFile } from "node:fs/promises"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import { parseSession } from "../../shared/session/parser"
import { splitInstanceSessionId } from "../../shared/session/instances"
import { runtimeFor, resolveSessionAgent } from "../agents/runtimes"
import { accessLevelOf, startTurn } from "../edition"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { commandScope } from "./durableSend"
import { orchestrationStore } from "../orchestration/storage"
import { fingerprint, OrchestrationError } from "../orchestration/store"

export interface TransitionInput { sessionId: string; commandId: string; expectedRevision: number; mode: "resume" | "handoff"; agent: AgentKind; instanceId?: string; targetSessionId?: string; message?: string }
export interface TransitionResolution { sessionId: string; commandId: string; targetSessionId?: string; confirmNotCreated?: boolean }
async function authorized(req: IncomingMessage, sessionId: string) {
  const level = await accessLevelOf(req, sessionId)
  if (!level || !accessAtLeast(level, "interact")) throw new OrchestrationError(403, "Session access is required for this transition")
}
export async function transitionConversation(req: IncomingMessage, input: TransitionInput) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.commandId) || !AGENT_KINDS.includes(input.agent) || !Number.isSafeInteger(input.expectedRevision) || !["resume", "handoff"].includes(input.mode)) throw new OrchestrationError(400, "Choose a transition policy and a stable commandId")
  await authorized(req, input.sessionId)
  const source = await resolveSessionAgent(input.sessionId)
  const store = orchestrationStore()
  const native = splitInstanceSessionId(input.sessionId)
  const sourceBinding = await nativeBinding(input.sessionId, source.kind, source.filePath)
  const conversation = store.ensureConversation(sourceBinding)
  const scope = commandScope(req)
  const id = `transition-${input.commandId}`
  const old = store.operation(scope, id)
  if (old) {
    if (old.fingerprint !== fingerprint(input)) throw new OrchestrationError(409, "commandId was reused for a different handoff")
    if (old.result) { await authorized(req, conversation.binding.sessionId); return old.result }
    throw new OrchestrationError(409, "Handoff delivery is uncertain; inspect native history before resolving it")
  }
  if (conversation.binding.sessionId !== input.sessionId) throw new OrchestrationError(409, "Open the conversation’s current session before changing providers")
  const currentRuntime = runtimeFor(source.kind, source.instanceId)
  if (currentRuntime.activity(input.sessionId).running) throw new OrchestrationError(409, "Interrupt or finish the active turn before switching providers")
  if (input.mode === "resume") {
    const targetId = input.targetSessionId || input.sessionId
    await authorized(req, targetId)
    const target = await resolveSessionAgent(targetId)
    if ((target.instanceId ?? "default") !== native.instanceId || target.kind !== source.kind || (target.instanceId ?? "default") !== (input.instanceId ?? native.instanceId) || input.agent !== source.kind) throw new OrchestrationError(409, "Native resume requires the same provider and account. Choose context handoff for a different account.")
    const binding = await nativeBinding(targetId, target.kind, target.filePath)
    store.beginTransition(scope, id, fingerprint(input), { input }, conversation.id, input.expectedRevision)
    return store.completeTransition(scope, id, conversation.id, input.expectedRevision, binding, { mode: input.mode })
  }
  if (!sourceBinding.filePath) throw new OrchestrationError(404, "Native history must be available before a context handoff")
  const parsed = parseSession(await readFile(sourceBinding.filePath, "utf8"))
  const cwd = parsed.cwd
  if (!cwd) throw new OrchestrationError(400, "The source session has no working directory")
  const context = parsed.turns.slice(-12).map((turn) => {
    const user = typeof turn.userMessage === "string" ? turn.userMessage : (turn.userMessage ?? []).flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
    return `User: ${user}\nAssistant: ${turn.assistantText.join("\n")}`
  }).join("\n\n").slice(-24000)
  const message = `Continue this conversation in the same project. The following is a bounded excerpt of prior conversation history, provided as context.\n\n${context}\n\nCurrent request: ${input.message || "Continue from the latest request; check the project’s current state first."}`
  const targetRuntime = runtimeFor(input.agent, input.instanceId ?? "default")
  const operation = store.beginTransition(scope, id, fingerprint(input), { input, message, cwd }, conversation.id, input.expectedRevision)
  if (!operation.fresh) {
    if (operation.result) return operation.result
    throw new OrchestrationError(409, "Handoff delivery is uncertain. Inspect provider history before starting another handoff.")
  }
  const started = await startTurn(req, Date.now(), targetRuntime, { dirName: descriptorFor(input.agent).dirName.encode(cwd), cwd, message, onSessionId: (sessionId) => store.recordOperationIdentity(scope, id, sessionId) })
  return store.completeTransition(scope, id, conversation.id, input.expectedRevision, await nativeBinding(started.sessionId, input.agent, started.filePath, cwd), { mode: input.mode, dirName: started.dirName, fileName: started.fileName, sessionId: started.sessionId })
}

export async function resolveConversationTransition(req: IncomingMessage, resolution: TransitionResolution) {
  await authorized(req, resolution.sessionId)
  const source = await resolveSessionAgent(resolution.sessionId)
  const store = orchestrationStore()
  const conversation = store.ensureConversation(await nativeBinding(resolution.sessionId, source.kind, source.filePath))
  await authorized(req, conversation.binding.sessionId)
  const scope = commandScope(req)
  const id = `transition-${resolution.commandId}`
  const operation = store.operation(scope, id)
  if (!operation) throw new OrchestrationError(404, "Handoff receipt not found")
  if (operation.result) return operation.result
  const input = operation.input.input as TransitionInput
  if (input.sessionId !== resolution.sessionId || store.pendingTransition(conversation.id, scope)?.id !== resolution.commandId) throw new OrchestrationError(409, "This handoff does not belong to the current conversation")
  if (resolution.confirmNotCreated === true && !resolution.targetSessionId) return store.abandonTransition(scope, id, conversation.id)
  const targetId = resolution.targetSessionId || String(operation.input.createdSessionId || "")
  if (!targetId) throw new OrchestrationError(400, "Supply the native session you found, or confirm that no session was created after inspecting history")
  await authorized(req, targetId)
  const target = await resolveSessionAgent(targetId)
  if (target.kind !== input.agent || (target.instanceId ?? "default") !== (input.instanceId ?? "default")) throw new OrchestrationError(409, "The recovered session must use the chosen provider and account")
  if (!target.filePath) throw new OrchestrationError(404, "Recovered native history is unavailable")
  const runtime = runtimeFor(target.kind, target.instanceId)
  if (runtime.activity(targetId).running) throw new OrchestrationError(409, "Wait for the recovered session to finish before attaching it")
  const parsed = parseSession(await readFile(target.filePath, "utf8"))
  const descriptor = descriptorFor(target.kind)
  const { instanceDirName } = await import("../../shared/session/instances")
  return store.completeTransition(scope, id, conversation.id, input.expectedRevision, await nativeBinding(targetId, target.kind, target.filePath, parsed.cwd), { mode: "handoff", sessionId: targetId, dirName: instanceDirName(target.instanceId ?? "default", descriptor.dirName.encode(parsed.cwd || "")), fileName: descriptor.sessionFile.name(splitInstanceSessionId(targetId).nativeId) })
}
