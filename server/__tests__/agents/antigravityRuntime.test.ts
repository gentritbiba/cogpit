// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createAcpRuntime } from "../../agents/acpRuntime"
import { createAntigravityStore } from "../../agents/acpStore"
import { antigravityProfile, antigravityToolUse, antigravityTurnSettings } from "../../agents/antigravityRuntime"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { formatFor, formatForText } from "../../../shared/session/agents"

const fixture = resolve("server/__tests__/fixtures/antigravity-agent.mjs")
const descriptor = descriptorFor("antigravity")
let home: string
let log: string
const runtimes: AgentRuntime[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cogpit-antigravity-"))
  log = join(home, "requests.jsonl")
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  await rm(home, { recursive: true, force: true })
})

function runtime(...args: string[]): AgentRuntime {
  const created = createAcpRuntime({ ...antigravityProfile, store: createAntigravityStore(home), launch: () => ({ command: "bun", args: [fixture, "--log", log, ...args], env: process.env }) })
  runtimes.push(created)
  return created
}

async function requests(method: string): Promise<Record<string, unknown>[]> {
  const lines = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
  return lines.filter((line) => line.method === method).map((line) => line.params)
}

async function until(predicate: () => boolean, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime state did not arrive")
    await new Promise((done) => setTimeout(done, 20))
  }
}

const start = (agent: AgentRuntime, message = "hello", extra: object = {}) => agent.start({ cwd: home, dirName: descriptor.dirName.encode(home), message, ...extra })

async function finished(agent: AgentRuntime, sessionId: string): Promise<void> {
  await until(() => !agent.activity(sessionId).running)
}

describe("Antigravity runtime", () => {
  it("names the session by the agent's own conversation id and writes a transcript Cogpit can parse", async () => {
    const agent = runtime()
    const started = await start(agent)
    await finished(agent, started.sessionId)
    const [session] = await requests("session/new")
    expect(session).toMatchObject({ cwd: home, mcpServers: [] })
    const text = await readFile(started.filePath, "utf8")
    expect(JSON.parse(text.split("\n", 1)[0]!)).toMatchObject({ type: "antigravity_session", sessionId: started.sessionId, nativeSessionId: started.sessionId })
    expect(formatForText(text)).toBe(formatFor("antigravity"))
    const parsed = formatFor("antigravity").parse(text)
    expect(parsed.agentKind).toBe("antigravity")
    expect(parsed.turns.flatMap((turn) => turn.assistantText).join("")).toContain("Done: hello")
    expect(text).toContain('"thinking":"Thinking it over"')
    expect(text).toContain('"usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":40')
  })

  it("applies the model, thinking level and mode through the agent's config options", async () => {
    const agent = runtime()
    const started = await start(agent, "hello", { model: "gemini-pro-agent", effort: "high", permissions: { mode: "acceptEdits" } })
    await finished(agent, started.sessionId)
    expect(await requests("session/set_config_option")).toEqual([
      { sessionId: started.sessionId, configId: "model", value: "gemini-pro-agent" },
      { sessionId: started.sessionId, configId: "thinking_level", value: "high" },
      { sessionId: started.sessionId, configId: "mode", value: "accept-edits" },
    ])
  })

  it("lists the account's models, with thinking levels only on the one the agent reported them for", async () => {
    const agent = runtime()
    const started = await start(agent)
    await finished(agent, started.sessionId)
    expect(await agent.listModels()).toEqual([
      { value: "", label: "Provider default", supportsEffort: false },
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportsEffort: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
      { value: "gemini-pro-agent", label: "Gemini 3.1 Pro", supportsEffort: false },
    ])
  })

  it("refuses a model the account does not offer instead of falling back", async () => {
    const agent = runtime()
    await expect(start(agent, "hello", { model: "gemini-unknown" })).rejects.toThrow("did not offer this model")
  })

  it("answers every permission request itself under full access", async () => {
    const agent = runtime()
    const started = await start(agent, "permission", { permissions: { mode: "bypassPermissions" } })
    await finished(agent, started.sessionId)
    expect(await readFile(started.filePath, "utf8")).toContain('\\"optionId\\":\\"allow-2\\"')
    expect((await requests("session/set_config_option")).some((params) => params.value === "yolo")).toBe(false)
  })

  it("asks the person when a request needs approval, showing the command it would run", async () => {
    const agent = runtime()
    const started = await start(agent, "permission", { permissions: { mode: "default" } })
    await until(() => agent.listPendingApprovals(started.sessionId).length === 1)
    const [approval] = agent.listPendingApprovals(started.sessionId)
    expect(approval).toMatchObject({ toolName: "Bash", input: { command: "rm -rf build" }, availableDecisions: ["allow", "allow_always", "deny"] })
    expect(await agent.respondToApproval(started.sessionId, approval!.requestId, "deny")).toBe(true)
    await finished(agent, started.sessionId)
    expect(await readFile(started.filePath, "utf8")).toContain('\\"optionId\\":\\"deny-2\\"')
  })

  it("treats an interaction request as a question to the person, even under full access", async () => {
    const agent = runtime()
    const started = await start(agent, "question", { permissions: { mode: "bypassPermissions" } })
    await until(() => agent.listPendingQuestions(started.sessionId).length === 1)
    const [question] = agent.listPendingQuestions(started.sessionId)
    expect(agent.listPendingApprovals(started.sessionId)).toEqual([])
    expect(question!.questions[0]).toMatchObject({ question: "Which database?", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] })
    await expect(agent.answerQuestion(started.sessionId, question!.toolUseId, "MySQL")).rejects.toThrow("offered options")
    expect(await agent.answerQuestion(started.sessionId, question!.toolUseId, { "Which database?": "SQLite" })).toEqual({ message: null })
    await finished(agent, started.sessionId)
    expect(await readFile(started.filePath, "utf8")).toContain('\\"optionId\\":\\"lite\\"')
  })

  it("records a command once its input arrives, with the output it printed", async () => {
    const agent = runtime()
    const started = await start(agent, "command")
    await finished(agent, started.sessionId)
    const records = (await readFile(started.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { message?: { content?: unknown } })
    const blocks = records.flatMap((value) => Array.isArray(value.message?.content) ? value.message.content as Record<string, unknown>[] : [])
    expect(blocks.filter((block) => block.type === "tool_use")).toEqual([{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls -a", cwd: "/work" } }])
    expect(blocks.find((block) => block.type === "tool_result")).toMatchObject({ tool_use_id: "call-1", content: "a\nb", is_error: false })
  })

  it("resumes a session the agent no longer holds", async () => {
    const first = runtime()
    const started = await start(first)
    await finished(first, started.sessionId)
    await first.shutdown()
    const second = runtime()
    const outcome = await second.send(started.sessionId, { message: "again", filePath: started.filePath })
    await outcome.completion
    expect(await requests("session/resume")).toEqual([{ sessionId: started.sessionId, cwd: home, mcpServers: [] }])
    expect(await requests("session/load")).toEqual([])
  })

  it("tells the person to sign in when the agent has no account", async () => {
    const agent = runtime("--signed-out")
    await expect(start(agent)).rejects.toThrow("Antigravity isn't signed in. Run: agy acp --login")
  })

  it("refuses a CLI older than the first one with a native ACP server", async () => {
    const agent = runtime("--version", "1.4.5")
    await expect(start(agent)).rejects.toThrow("Antigravity CLI 1.5 or newer is required (found 1.4.5). Run: agy update")
  })
})

describe("Antigravity turn settings", () => {
  it("keeps full access in the agent's default mode, since Cogpit answers its requests", () => {
    expect(antigravityTurnSettings({ permissions: { mode: "bypassPermissions" } })).toEqual([{ category: "mode", value: "default", required: false }])
    expect(antigravityTurnSettings({ permissions: { mode: "plan" } })).toEqual([{ category: "mode", value: "plan", required: true }])
  })

  it("rejects settings the agent has no way to honour", () => {
    expect(() => antigravityTurnSettings({ fastMode: true })).toThrow("not supported by Antigravity")
    expect(() => antigravityTurnSettings({ permissions: { mode: "dontAsk" } })).toThrow('no "dontAsk" mode')
  })
})

describe("Antigravity tool calls", () => {
  it("draws edits, reads, searches and checklists with the matching cards", () => {
    expect(antigravityToolUse({ toolCallId: "1", kind: "edit", title: "Running edit_file", content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }] })).toEqual({ name: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } })
    expect(antigravityToolUse({ toolCallId: "2", kind: "edit", content: [{ type: "diff", path: "/w/new.ts", oldText: null, newText: "x" }] })).toEqual({ name: "Write", input: { file_path: "/w/new.ts", content: "x" } })
    expect(antigravityToolUse({ toolCallId: "3", kind: "read", title: "Running view_file", rawInput: { AbsolutePath: "/w/a.ts" } })).toEqual({ name: "Read", input: { file_path: "/w/a.ts" } })
    expect(antigravityToolUse({ toolCallId: "4", title: "Running search_web", rawInput: { query: "acp spec" } })).toEqual({ name: "WebSearch", input: { query: "acp spec" } })
    expect(antigravityToolUse({ toolCallId: "5", title: "Run update_steps", rawInput: { steps: [{ title: "Plan", status: "done" }, { title: "Build", status: "in_progress" }, { title: "Ship" }] } })).toEqual({ name: "TodoWrite", input: { todos: [{ content: "Plan", status: "completed" }, { content: "Build", status: "in_progress" }, { content: "Ship", status: "pending" }] } })
    expect(antigravityToolUse({ toolCallId: "6", title: "Run start_subagent?", rawInput: { Role: "tester" } })).toEqual({ name: "start_subagent", input: { Role: "tester" } })
  })
})

describe("Antigravity descriptor", () => {
  it("resumes and launches the way the agy CLI expects", () => {
    expect(descriptor.resume.command("6f9619ff-8b86-d011-b42d-00cf4fc964ff", "/work/app")).toBe("cd '/work/app' && agy --conversation 6f9619ff-8b86-d011-b42d-00cf4fc964ff")
    expect(descriptor.launchArgs.permissions({ mode: "bypassPermissions" })).toEqual(["--dangerously-skip-permissions"])
    expect(descriptor.launchArgs.permissions({ mode: "acceptEdits" })).toEqual(["--mode", "accept-edits"])
    expect(descriptor.cli.process.sessionIdFromCommand("agy --conversation 6f9619ff-8b86-d011-b42d-00cf4fc964ff")).toBe("6f9619ff-8b86-d011-b42d-00cf4fc964ff")
    expect(descriptor.cli.install?.command("linux")).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash")
    expect(descriptor.cli.signIn?.args).toEqual(["acp", "--login"])
  })
})
