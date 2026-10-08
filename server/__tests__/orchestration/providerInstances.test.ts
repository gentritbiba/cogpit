// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createProviderInstance } from "../../agents/instanceConfigurations"
import { createInstanceRuntime, providerInstanceEnvironment } from "../../agents/instanceRuntime"
import { createInstanceStore } from "../../agents/instanceStores"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { deriveSessionStatus } from "../../../shared/session/sessionStatus"
import { parseSession } from "../../../shared/session/parser"
import { scopeParsedSession } from "../../../shared/session/instances"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import { subscribe, type StreamBusEvent } from "../../lib/streamBus"
const originalBrowserHome = process.env.COGPIT_BROWSER_HOME
beforeEach(() => { process.env.COGPIT_BROWSER_HOME = join(process.env.COGPIT_ORCHESTRATION_ROOT!, "browser") })
afterEach(() => { if (originalBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME; else process.env.COGPIT_BROWSER_HOME = originalBrowserHome })
const runtimes: AgentRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.shutdown() })
async function instance(label: string, args: string[] = []) {
  const configuration = await createProviderInstance({ agent: "acp", label, executable: "bun", args: [resolve("server/__tests__/fixtures/acp-agent.mjs"), ...args] })
  const runtime = createInstanceRuntime(configuration, process.env.COGPIT_ORCHESTRATION_ROOT!)
  runtimes.push(runtime)
  return { configuration, runtime, store: createInstanceStore(configuration) }
}
async function until(predicate: () => boolean, timeout = 10000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error("Provider state did not arrive"); await new Promise((resolve) => setTimeout(resolve, 20)) } }
describe("provider instances and ACP", () => {
  it("qualifies isolated native plans and sends answers only to their owning worker", async () => {
    let executable = resolve("server/__tests__/fixtures/plan-provider.mjs")
    if (process.platform === "win32") {
      const fixture = executable
      executable = join(process.env.COGPIT_ORCHESTRATION_ROOT!, "plan-provider.cmd")
      await writeFile(executable, `@echo off\r\nbun "${fixture}" %*\r\n`)
    }
    const configuration = await createProviderInstance({ agent: "copilot", label: "Plan account", executable })
    const runtime = createInstanceRuntime(configuration, process.env.COGPIT_ORCHESTRATION_ROOT!)
    runtimes.push(runtime)
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const started = await runtime.start({ cwd, dirName: descriptorFor("copilot").dirName.encode(cwd), message: "Make a plan", permissions: { mode: "plan" } })
    await until(() => (runtime.listPendingPlans?.(started.sessionId).length ?? 0) === 1)
    const plan = runtime.listPendingPlans!(started.sessionId)[0]!
    expect(plan.sessionId).toBe(started.sessionId)
    expect(plan.summary).toBe("Synthetic account plan")
    expect(runtime.listPendingPlans?.("foreign-session")).toEqual([])
    await expect(runtime.respondToPlan!("foreign-session", plan.requestId, { approved: true })).rejects.toThrow("different provider instance")
    expect(await runtime.respondToPlan!(started.sessionId, plan.requestId, { approved: true, selectedAction: "autopilot" })).toBe(true)
    await until(() => (runtime.listPendingPlans?.(started.sessionId).length ?? 0) === 0)
    expect(await readFile(started.filePath, "utf8")).toContain('"selectedAction":"autopilot"')
  }, 20000)

  it("waits for initialization for concurrent creates, forwards scoped live events and honors offered models", async () => {
    const account = await instance("Concurrent")
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const request = { cwd, dirName: descriptorFor("acp").dirName.encode(cwd) }
    const [a, b] = await Promise.all([account.runtime.start(request), account.runtime.start(request)])
    expect(a.sessionId).not.toBe(b.sessionId)
    const events: StreamBusEvent[] = []
    const unsubscribe = subscribe(a.sessionId, (event) => events.push(event))
    try {
      const delivered = await account.runtime.send(a.sessionId, { message: "progress", model: "fixture-alt" })
      await delivered.completion
      const completed = parseSession(await readFile(a.filePath, "utf8"))
      expect(deriveSessionStatus(completed.rawMessages).status).toBe("completed")
      expect(account.runtime.activity(a.sessionId).running).toBe(false)
      await until(() => events.some((event) => event.type === "agent_progress"))
      expect(events).toContainEqual({ type: "agent_progress", toolUseId: "native-tool-42", summary: "Fixture progress" })
      expect((await account.runtime.listModels())?.map((option) => option.value)).toContain("fixture-alt")
      await expect(account.runtime.send(a.sessionId, { message: "rejected", model: "unknown-model" })).rejects.toMatchObject({ status: 400 })
      await expect(account.runtime.send(a.sessionId, { message: "rejected", effort: "high" })).rejects.toMatchObject({ status: 400 })
      expect(await readFile(a.filePath, "utf8")).not.toContain("rejected")
    } finally { unsubscribe() }
  }, 20000)
  it("fails incompatible protocols and providers that cannot reload without silently creating a replacement", async () => {
    const invalid = await instance("Invalid protocol", ["--wrong-protocol"])
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const request = { cwd, dirName: descriptorFor("acp").dirName.encode(cwd) }
    await expect(invalid.runtime.start(request)).rejects.toThrow("Unsupported ACP protocol")
    const account = await instance("No reload", ["--no-load"])
    const started = await account.runtime.start(request)
    await account.runtime.shutdown()
    await expect(account.runtime.send(started.sessionId, { message: "reload", filePath: started.filePath })).rejects.toThrow("cannot reload")
  }, 20000)
  it("isolates processes, homes, transcripts and native IDs between two accounts", async () => {
    const [first, second] = await Promise.all([instance("First"), instance("Second")])
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const request = { cwd, dirName: descriptorFor("acp").dirName.encode(cwd) }
    const [a, b] = await Promise.all([first.runtime.start(request), second.runtime.start(request)])
    expect(a.sessionId).not.toBe(b.sessionId)
    const [one, two] = await Promise.all([first.runtime.send(a.sessionId, { message: "one" }), second.runtime.send(b.sessionId, { message: "two" })])
    expect(await one.completion).toMatchObject({ isError: false })
    expect(await two.completion).toMatchObject({ isError: false })
    const parsed = scopeParsedSession(parseSession(await readFile(a.filePath, "utf8")), first.configuration.id)
    expect(parsed.agentKind).toBe("acp")
    expect(parsed.sessionId).toBe(a.sessionId)
    expect(parsed.turns.flatMap((turn) => turn.assistantText).join("\n")).toContain(join(first.configuration.homeDir, "user"))
    expect(await second.store.findSessionFile(a.sessionId)).toBeNull()
    expect(await first.store.findSessionFile(a.sessionId)).toBe(a.filePath)
    await expect(second.runtime.send(a.sessionId, { message: "wrong account" })).rejects.toThrow("different provider instance")
    const env = providerInstanceEnvironment(first.configuration, cwd)
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.HOME).not.toBe(process.env.HOME)
  }, 20000)
  it("keeps native permission option IDs and supports cancel and reload", async () => {
    const account = await instance("Permissions")
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const started = await account.runtime.start({ cwd, dirName: descriptorFor("acp").dirName.encode(cwd) })
    const sending = await account.runtime.send(started.sessionId, { message: "permission" })
    await until(() => account.runtime.listPendingApprovals(started.sessionId).length === 1)
    const pending = account.runtime.listPendingApprovals(started.sessionId)[0]!
    expect(account.runtime.activity(started.sessionId).running).toBe(true)
    expect(pending.toolUseId).toBe("native-tool-42")
    expect(await account.runtime.respondToApproval(started.sessionId, pending.requestId, "allow")).toBe(true)
    await sending.completion
    expect(account.runtime.activity(started.sessionId).running).toBe(false)
    expect(account.runtime.listPendingApprovals(started.sessionId)).toEqual([])
    expect(await readFile(started.filePath, "utf8")).toContain("native-allow-42")
    const waiting = await account.runtime.send(started.sessionId, { message: "wait" })
    await until(() => account.runtime.activity(started.sessionId).running)
    expect((await account.runtime.send(started.sessionId, { message: "busy" })).delivery).toBe("busy")
    await account.runtime.interrupt(started.sessionId)
    expect(await waiting.completion).toMatchObject({ isError: true, message: "cancelled" })
    const restarted = await account.runtime.send(started.sessionId, { message: "immediate restart" })
    expect(restarted.delivery).toBe("started")
    expect(await restarted.completion).toMatchObject({ isError: false })
    await account.runtime.shutdown()
    const resumed = await account.runtime.send(started.sessionId, { message: "resumed", filePath: started.filePath })
    expect(await resumed.completion).toMatchObject({ isError: false })
    expect(await readFile(started.filePath, "utf8")).not.toContain("REPLAYED-HISTORY")
  }, 20000)
  it("persists one terminal record after a provider crash and resumes without detached writes", async () => {
    const account = await instance("Crash recovery")
    const cwd = process.env.COGPIT_ORCHESTRATION_ROOT!
    const started = await account.runtime.start({ cwd, dirName: descriptorFor("acp").dirName.encode(cwd) })
    const first = await account.runtime.send(started.sessionId, { message: "success" })
    await first.completion
    const crashed = await account.runtime.send(started.sessionId, { message: "crash" })
    await expect(crashed.completion).rejects.toThrow()
    await until(() => !account.runtime.activity(started.sessionId).running)
    const transcript = await readFile(started.filePath, "utf8")
    expect(deriveSessionStatus(parseSession(transcript).rawMessages).status).toBe("completed")
    expect(transcript.match(/"stop_reason":"end_turn"/g)).toHaveLength(2)
    expect(transcript.match(/"subtype":"error_during_execution"/g)).toHaveLength(1)
    const resumed = await account.runtime.send(started.sessionId, { message: "resumed after crash", filePath: started.filePath })
    expect(await resumed.completion).toMatchObject({ isError: false })
    const restored = await readFile(started.filePath, "utf8")
    expect(restored.match(/"stop_reason":"end_turn"/g)).toHaveLength(3)
    expect(restored.match(/"subtype":"error_during_execution"/g)).toHaveLength(1)
    expect(deriveSessionStatus(parseSession(restored).rawMessages).status).toBe("completed")
  }, 20000)
})
