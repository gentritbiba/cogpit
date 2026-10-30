import { isSessionStarting, finishSessionStartup } from "./runtimeTypes"
import { beforeFirstTurn } from "./startup"
import { fork, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { browserHome } from "../browser/paths"
import { noteBrowserProfiles } from "../browser/owners"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { instanceDirName, instanceSessionId, splitInstanceSessionId, splitInstanceDirName } from "../../shared/session/instances"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import { isRecord } from "../../shared/objects"
import { orchestrationStore } from "../orchestration/storage"
import { pluginSkillContext } from "../plugins/skillContext"
import type { CodexAsyncQuestion } from "./codexQuestions"
import type { UsageCostRecord } from "./usageScanners"
import * as streamBus from "../lib/streamBus"
import { AgentRuntimeError, NO_ACTIVITY, reportSessionId, type AgentRuntime, type PendingApproval, type PendingQuestion, type PendingPlan, type RuntimeActivity, type SendOutcome, type StartSessionRequest, type TurnResult } from "./runtimeTypes"

interface Call { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; identity?: (id: string) => void; beforeFirstTurn?: StartSessionRequest["beforeFirstTurn"]; startupError?: Error }
export function providerInstanceEnvironment(instance: ProviderInstance, dataRoot: string): NodeJS.ProcessEnv {
  const descriptor = descriptorFor(instance.agent)
  const userRoot = join(instance.homeDir, "user")
  for (const directory of [userRoot, join(userRoot, ".config"), join(userRoot, ".cache"), join(userRoot, ".local/share"), join(userRoot, "tmp")]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "COGPIT_PORT"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
  Object.assign(env, { HOME: userRoot, USERPROFILE: userRoot, XDG_CONFIG_HOME: join(userRoot, ".config"), XDG_CACHE_HOME: join(userRoot, ".cache"), XDG_DATA_HOME: join(userRoot, ".local/share"), TMPDIR: join(userRoot, "tmp"), TEMP: join(userRoot, "tmp"), TMP: join(userRoot, "tmp"), COGPIT_AGENT_WORKER: "1", COGPIT_AGENT_INSTANCE_ID: instance.id, COGPIT_WORKER_AGENT: instance.agent, COGPIT_WORKER_DATA_ROOT: join(instance.homeDir, "cogpit"), COGPIT_WORKER_CONFIG_PATH: join(instance.homeDir, "config.json"), COGPIT_ORCHESTRATION_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: "1" })
  if (descriptor.cli.homeEnvVar) env[descriptor.cli.homeEnvVar] = instance.homeDir
  if (descriptor.cli.bundledBySdk) env.CLAUDE_CONFIG_DIR = instance.homeDir
  env.COGPIT_BROWSER_HOME = browserHome()
  if (instance.executable) env.COGPIT_PROVIDER_EXECUTABLE = instance.executable
  if (instance.args) env.COGPIT_PROVIDER_ARGS = JSON.stringify(instance.args)
  return env
}

export function createInstanceRuntime(instance: ProviderInstance, dataRoot: string): AgentRuntime {
  const descriptor = descriptorFor(instance.agent)
  let child: ChildProcess | null = null
  let nextId = 0
  const pending = new Map<number, Call>()
  const completions = new Map<number, { resolve: (value: TurnResult) => void; reject: (error: Error) => void }>()
  const earlyCompletions = new Map<number, { value?: TurnResult; error?: string }>()
  let active: Array<{ sessionId: string; turnId?: string }> = []
  let activity: Record<string, RuntimeActivity> = {}
  let approvals: PendingApproval[] = []
  let questions: PendingQuestion[] = []
  let plans: PendingPlan[] = []
  const watched = new Set<string>()
  const qualified = (nativeId: string) => instanceSessionId(instance.id, nativeId)
  const native = (sessionId: string) => {
    const parts = splitInstanceSessionId(sessionId)
    if (parts.instanceId !== instance.id) throw new AgentRuntimeError(409, "INSTANCE_MISMATCH", "This session belongs to a different provider instance")
    return parts.nativeId
  }
  function disconnect(error: Error) {
    for (const id of watched) streamBus.clear(qualified(id))
    child = null; active = []; activity = {}; approvals = []; questions = []; plans = []
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }
    pending.clear()
    for (const completion of completions.values()) completion.reject(error)
    completions.clear(); earlyCompletions.clear()
  }
  function processFor(): ChildProcess {
    if (child) return child
    const source = fileURLToPath(new URL("./instanceWorker.ts", import.meta.url))
    const script = existsSync(source) ? source : fileURLToPath(new URL("./instance-worker.js", import.meta.url))
    if (!existsSync(script)) throw new AgentRuntimeError(503, "WORKER_UNAVAILABLE", "Provider instance worker is missing; rebuild Cogpit")
    const worker = fork(script, [], { execPath: script.endsWith(".ts") ? "bun" : process.execPath, execArgv: [], env: providerInstanceEnvironment(instance, dataRoot), stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" })
    child = worker
    worker.on("error", (error) => { if (child === worker) disconnect(error) })
    worker.on("exit", () => { if (child === worker) disconnect(new Error("Provider instance worker exited; native input channels expired")) })
    worker.on("message", (message: unknown) => {
      if (child !== worker || !isRecord(message)) return
      if (message.type === "plugin-skills" && Number.isSafeInteger(message.requestId) && typeof message.cwd === "string" && message.cwd.length <= 8192) {
        const requestId = message.requestId
        void Promise.resolve(pluginSkillContext(message.cwd)).then(instructions => {
          if (child === worker && worker.connected) worker.send({ type: "plugin-skills-result", requestId, instructions: instructions ?? "" }, () => {})
        })
        return
      }
      if (message.type === "stream" && typeof message.sessionId === "string" && isRecord(message.event) && watched.has(message.sessionId)) { streamBus.forwardEvent(qualified(message.sessionId), message.event as unknown as streamBus.StreamBusEvent); return }
      if (message.type === "snapshot" && isRecord(message.value)) {
        const value = message.value
        active = Array.isArray(value.active) ? value.active as typeof active : []
        activity = isRecord(value.activity) ? value.activity as typeof activity : {}
        approvals = Array.isArray(value.approvals) ? value.approvals as PendingApproval[] : []
        questions = Array.isArray(value.questions) ? value.questions as PendingQuestion[] : []
        plans = Array.isArray(value.plans) ? value.plans as PendingPlan[] : []
        return
      }
      if (typeof message.id !== "number") return
      const id = message.id
      if (message.type === "startup-ready" && typeof message.cwd === "string") {
        const call = pending.get(id)
        const ready = call?.beforeFirstTurn
        void Promise.resolve().then(async () => {
          if (!ready) throw new Error("Startup authorization is no longer available")
          await ready({ cwd: message.cwd as string, nativeWorktree: message.nativeWorktree === true, sessionId: typeof message.sessionId === "string" ? qualified(message.sessionId) : undefined })
        }).then(() => {
          if (child === worker && worker.connected) worker.send({ type: "startup-ready-result", id }, () => {})
        }, (error: unknown) => {
          if (call && error instanceof Error) call.startupError = error
          if (child === worker && worker.connected) worker.send({ type: "startup-ready-result", id, error: error instanceof Error ? error.message : "Startup refused" }, () => {})
        })
        return
      }
      if (message.type === "identity" && typeof message.sessionId === "string") { watched.add(message.sessionId); const sessionId = qualified(message.sessionId); pending.get(id)?.identity?.(sessionId); noteBrowserProfiles(sessionId); return }
      if (message.type === "completion") {
        const completion = completions.get(id)
        const value = { value: message.value as TurnResult | undefined, error: typeof message.error === "string" ? message.error : undefined }
        if (completion) { completions.delete(id); if (value.error) completion.reject(new Error(value.error)); else completion.resolve(value.value!) }
        else { earlyCompletions.set(id, value); while (earlyCompletions.size > 256) earlyCompletions.delete(earlyCompletions.keys().next().value!) }
        return
      }
      const call = pending.get(id)
      if (!call) return
      pending.delete(id); clearTimeout(call.timer)
      if (typeof message.error === "string") call.reject(call.startupError ?? new AgentRuntimeError(Number(message.status) || 502, typeof message.code === "string" ? message.code : "INSTANCE_ERROR", message.error))
      else call.resolve(message.value)
    })
    return worker
  }
  async function call<T>(method: string, args: unknown[], identity?: (id: string) => void, timeoutMs = 120000, beforeFirstTurn?: StartSessionRequest["beforeFirstTurn"], signal?: AbortSignal): Promise<{ id: number; value: T }> {
    signal?.throwIfAborted()
    if (pending.size >= 100) throw new AgentRuntimeError(429, "INSTANCE_BUSY", "Provider instance has too many pending operations")
    const worker = processFor(); const id = ++nextId
    const value = await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { const call = pending.get(id); pending.delete(id); if (method === "start") abort(); call?.reject(new Error("Provider instance operation timed out; inspect session history before retrying")) }, timeoutMs)
      const abort = () => { if (worker.connected) worker.send({ type: "startup-abort", id }, () => {}) }
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      pending.set(id, { resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T) }, reject: (error) => { signal?.removeEventListener("abort", abort); reject(error) }, timer, identity, beforeFirstTurn })
      worker.send({ id, method, args }, (error) => { if (error) { clearTimeout(timer); const call = pending.get(id); pending.delete(id); call?.reject(error) } })
    })
    return { id, value }
  }
  const rpc = async <T>(method: string, args: unknown[]): Promise<T> => (await call<T>(method, args)).value
  return {
    kind: instance.agent, instanceId: instance.id, descriptor,
    isBusy: () => pending.size > 0 || completions.size > 0 || active.length > 0,
    async start(request: StartSessionRequest) {
      let announced: string | undefined
      try {
        const { value } = await call<Awaited<ReturnType<AgentRuntime["start"]>>>("start", [{ ...request, signal: undefined, beforeFirstTurn: Boolean(request.beforeFirstTurn), onSessionId: undefined, dirName: splitInstanceDirName(request.dirName).nativeDirName }], (id) => { announced = id; reportSessionId(request, id) }, request.beforeFirstTurn ? 24 * 60 * 60_000 : 120_000, request.beforeFirstTurn ? (identity) => beforeFirstTurn(request, identity) : undefined, request.signal)
        return { ...value, sessionId: qualified(value.sessionId), dirName: instanceDirName(instance.id, value.dirName) }
      } finally { if (announced) finishSessionStartup(announced) }
    },
    async send(sessionId, request) {
      if (isSessionStarting(sessionId)) return { delivery: "busy" }
      watched.add(native(sessionId))
      const { id, value } = await call<SendOutcome & { hasCompletion?: boolean }>("send", [native(sessionId), request])
      if (!value.hasCompletion) return value
      const completion = new Promise<TurnResult>((resolve, reject) => {
        const early = earlyCompletions.get(id)
        if (early) { earlyCompletions.delete(id); if (early.error) reject(new Error(early.error)); else resolve(early.value!); return }
        completions.set(id, { resolve, reject })
      })
      return { delivery: value.delivery, turnId: value.turnId, completion }
    },
    interrupt: (id) => rpc("interrupt", [native(id)]), stop: (id) => rpc("stop", [native(id)]), stopAll: () => rpc("stopAll", []),
    deleteSession: (id, path) => rpc("deleteSession", [native(id), path]),
    activity: (id) => splitInstanceSessionId(id).instanceId === instance.id ? activity[native(id)] ?? NO_ACTIVITY : NO_ACTIVITY,
    hasSession: (id) => { const parts = splitInstanceSessionId(id); return parts.instanceId === instance.id && Boolean(activity[parts.nativeId]?.live || activity[parts.nativeId]?.running || [...approvals, ...questions, ...plans].some((request) => request.sessionId === parts.nativeId)) },
    listActive: () => active.map((s) => ({ ...s, sessionId: qualified(s.sessionId) })),
    listPendingApprovals: (id) => id && splitInstanceSessionId(id).instanceId !== instance.id ? [] : approvals.filter((q) => !id || q.sessionId === native(id)).map((q) => ({ ...q, sessionId: qualified(q.sessionId) })),
    respondToApproval: (id, requestId, decision) => rpc("respondToApproval", [native(id), requestId, decision]),
    respondToAllApprovals: (id, decision) => rpc("respondToAllApprovals", [native(id), decision]),
    listPendingPlans: (id) => id && splitInstanceSessionId(id).instanceId !== instance.id ? [] : plans.filter((plan) => !id || plan.sessionId === native(id)).map((plan) => ({ ...plan, sessionId: qualified(plan.sessionId) })),
    respondToPlan: async (id, requestId, response) => rpc("respondToPlan", [native(id), requestId, response]),
    listPendingQuestions: (id) => {
      if (id && splitInstanceSessionId(id).instanceId !== instance.id) return []
      if (instance.agent === "codex") return orchestrationStore().questions(instance.id, id ? native(id) : undefined).map((q) => { const question = q.data as CodexAsyncQuestion; return { sessionId: qualified(question.threadId), toolUseId: question.itemId, askedAt: question.askedAt, questions: question.questions } })
      return questions.filter((q) => !id || q.sessionId === native(id)).map((q) => ({ ...q, sessionId: qualified(q.sessionId) }))
    },
    async answerQuestion(id, requestId, answer) {
      const accepted = await rpc<Awaited<ReturnType<AgentRuntime["answerQuestion"]>>>("answerQuestion", [native(id), requestId, answer])
      return accepted ? { ...accepted, onDelivered: () => { void rpc("commitAnswer", [native(id), requestId]).catch(() => {}) } } : null
    },
    describeRuntime: (force) => rpc("describeRuntime", [force]), listModels: () => rpc("listModels", []),
    async liveUsageRecords(alreadyCounted, sessionIds) {
      const counted = [...alreadyCounted].filter(([id]) => splitInstanceSessionId(id).instanceId === instance.id).map(([id, models]) => [native(id), [...models]])
      const ids = sessionIds ? [...sessionIds].filter((id) => splitInstanceSessionId(id).instanceId === instance.id).map(native) : null
      const records = await rpc<UsageCostRecord[]>("liveUsageRecords", [counted, ids])
      return records.map((record) => ({ ...record, sessionId: qualified(record.sessionId), dedupeKey: record.dedupeKey ? `${instance.id}:${record.dedupeKey}` : null }))
    },
    async fork(id, at) { const result = await rpc<Awaited<ReturnType<AgentRuntime["fork"]>>>("fork", [native(id), at]); return { ...result, sessionId: qualified(result.sessionId) } },
    async shutdown() {
      const worker = child
      if (!worker) return
      try { await call("shutdown", [], undefined, 5000) } finally { worker.kill("SIGTERM"); if (child === worker) disconnect(new Error("Provider instance shut down")) }
    },
  }
}
