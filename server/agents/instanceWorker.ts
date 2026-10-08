import { setConfigPath, setDataRoot, loadConfig } from "../config"
import { refreshDirs } from "../dirs"
import { runtimeFor } from "./runtimes"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { isRecord } from "../../shared/objects"
import * as streamBus from "../lib/streamBus"

const kind = process.env.COGPIT_WORKER_AGENT as AgentKind
const dataRoot = process.env.COGPIT_WORKER_DATA_ROOT
if (!dataRoot || !kind || !process.send) throw new Error("Instance worker must be started by Cogpit")
setDataRoot(dataRoot)
setConfigPath(process.env.COGPIT_WORKER_CONFIG_PATH ?? "")
await loadConfig()
refreshDirs()
const runtime = runtimeFor(kind)
const answers = new Map<string, () => void>()
const methods = new Set(["start", "send", "interrupt", "stop", "stopAll", "deleteSession", "respondToApproval", "respondToAllApprovals", "respondToPlan", "answerQuestion", "describeRuntime", "listModels", "liveUsageRecords", "fork", "shutdown", "snapshot", "commitAnswer"])
function send(message: unknown) { if (process.connected) process.send?.(message) }
function snapshot() {
  const ids = runtime.listActive().map((s) => s.sessionId)
  return { active: runtime.listActive(), activity: Object.fromEntries(ids.map((id) => [id, runtime.activity(id)])), approvals: runtime.listPendingApprovals(), questions: runtime.listPendingQuestions(), plans: runtime.listPendingPlans?.() ?? [] }
}
const watched = new Set<string>()
const streamSubscriptions = new Map<string, () => void>()
function watch(id: string) {
  if (watched.has(id)) return
  watched.add(id)
  streamSubscriptions.set(id, streamBus.subscribe(id, (event) => send({ type: "stream", sessionId: id, event })))
}
function unwatch(id: string) { watched.delete(id); streamSubscriptions.get(id)?.(); streamSubscriptions.delete(id); streamBus.clear(id) }
function publishSnapshot() {
  send({ type: "snapshot", value: { ...snapshot(), activity: Object.fromEntries([...watched].map((id) => [id, runtime.activity(id)])) } })
}
const poll = setInterval(publishSnapshot, 300)
poll.unref()
process.on("message", (message: unknown) => {
  if (!isRecord(message) || typeof message.id !== "number" || typeof message.method !== "string" || !methods.has(message.method) || !Array.isArray(message.args)) return
  const { id, method, args } = message
  void (async () => {
    if (method === "snapshot") return snapshot()
    if (method === "commitAnswer") { answers.get(JSON.stringify(args))?.(); answers.delete(JSON.stringify(args)); return true }
    if (method === "liveUsageRecords") { args[0] = new Map((args[0] as Array<[string, Array<[string, unknown]>]>).map(([id, models]) => [id, new Map(models)])); args[1] = Array.isArray(args[1]) ? new Set(args[1]) : undefined }
    if (method === "start" && isRecord(args[0])) args[0].onSessionId = (sessionId: string) => { watch(sessionId); send({ type: "identity", id, sessionId }) }
    if (typeof args[0] === "string") watch(args[0])
    const operation = runtime[method as keyof typeof runtime]
    if (typeof operation !== "function") throw new Error("Unsupported runtime operation")
    const result: unknown = await Reflect.apply(operation, runtime, args)
    if (method === "deleteSession" || method === "stop") unwatch(String(args[0]))
    if (method === "stopAll" || method === "shutdown") for (const id of watched) unwatch(id)
    if (method === "answerQuestion" && isRecord(result)) {
      if (typeof result.onDelivered === "function") answers.set(JSON.stringify([args[0], args[1]]), result.onDelivered as () => void)
      return { ...result, onDelivered: undefined }
    }
    if (method === "send" && isRecord(result)) {
      let completion = result.completion as Promise<unknown> | undefined
      if (!completion && typeof result.turnId === "string" && runtime.waitForCompletion) completion = runtime.waitForCompletion(String(args[0]), result.turnId)
      if (completion) {
        void completion.then((value) => {
          publishSnapshot()
          send({ type: "completion", id, value })
        }, (error: unknown) => {
          publishSnapshot()
          send({ type: "completion", id, error: error instanceof Error ? error.message : "Turn completion unavailable" })
        })
      }
      return { ...result, completion: undefined, hasCompletion: Boolean(completion) }
    }
    return result
  })().then((value) => send({ id, value }), (error: unknown) => send({ id, error: error instanceof Error ? error.message : "Instance operation failed", status: isRecord(error) ? error.status : undefined, code: isRecord(error) ? error.code : undefined }))
})
async function close() { clearInterval(poll); await runtime.shutdown(); process.disconnect?.() }
process.on("disconnect", () => { void close().finally(() => process.exit(0)) })
