import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"
import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"

// Speaks ACP the way `agy acp` 1.5 does. Every request it receives is logged to
// the file named by `--log`, so a test can read what the client asked for.
const option = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1] }
const log = option("--log")
const record = (method, params) => { if (log) appendFileSync(log, JSON.stringify({ method, params }) + "\n") }
const version = option("--version") ?? "1.5.16"
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-pro-agent", name: "Gemini 3.1 Pro" }] },
  { id: "thinking_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }, { value: "plan", name: "Plan" }] },
]
const cancellations = new Map()
const app = agent({ name: "Antigravity ACP Server" })
app.onRequest("initialize", ({ params }) => {
  record("initialize", params)
  return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "Antigravity ACP Server", version }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} }, promptCapabilities: { image: true, audio: true, embeddedContext: true } }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] }
})
app.onRequest("session/new", ({ params }) => {
  record("session/new", params)
  if (process.argv.includes("--signed-out")) throw new RequestError(-32000, "Authentication required")
  return { sessionId: randomUUID(), configOptions: configOptions() }
})
app.onRequest("session/resume", ({ params }) => { record("session/resume", params); return { configOptions: configOptions() } })
app.onRequest("session/load", ({ params }) => { record("session/load", params); return { configOptions: configOptions() } })
app.onRequest("session/set_config_option", ({ params }) => {
  record("session/set_config_option", params)
  return { configOptions: configOptions().map((value) => value.id === params.configId ? { ...value, currentValue: params.value } : value) }
})
app.onNotification("session/cancel", ({ params }) => { cancellations.get(params.sessionId)?.({ stopReason: "cancelled" }); cancellations.delete(params.sessionId) })
app.onRequest("session/prompt", async ({ params, client }) => {
  record("session/prompt", params)
  const sessionId = params.sessionId
  const text = params.prompt.filter((value) => value.type === "text").map((value) => value.text).at(-1)
  const update = (value) => client.notify("session/update", { sessionId, update: value })
  const reply = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } })
  if (text === "wait") return new Promise((resolve) => cancellations.set(sessionId, resolve))
  if (text === "hold") {
    // Ends the turn only once its permission request is answered, as ACP agents may.
    const response = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "call-3", title: "Run run_command?", kind: "execute", rawInput: { CommandLine: "sleep 60" } }, options: [{ optionId: "allow-3", name: "Allow once", kind: "allow_once" }, { optionId: "deny-3", name: "Deny", kind: "reject_once" }] })
    return { stopReason: response.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" }
  }
  if (text === "unfinished") await update({ sessionUpdate: "tool_call", toolCallId: "call-4", title: "Running run_command", status: "pending" })
  if (text === "command") {
    await update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Running run_command", status: "pending" })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", rawInput: { CommandLine: "ls -a", Cwd: "/work" } })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { combinedOutput: "a\nb", exitCode: 0 } })
  }
  if (text === "permission") {
    const response = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "call-2", title: "Run run_command?", kind: "execute", rawInput: { CommandLine: "rm -rf build" } }, options: [{ optionId: "allow-2", name: "Allow once", kind: "allow_once" }, { optionId: "always-2", name: "Allow for this conversation", kind: "allow_always" }, { optionId: "deny-2", name: "Deny", kind: "reject_once" }] })
    await reply(`Permission: ${JSON.stringify(response)}`)
  }
  if (text === "question") {
    const response = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "interaction_7", title: "Which database?" }, options: [{ optionId: "pg", name: "Postgres", kind: "allow_once" }, { optionId: "lite", name: "SQLite", kind: "allow_once" }] })
    await reply(`Answer: ${JSON.stringify(response)}`)
  }
  await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over" } })
  await reply(`Done: ${text}`)
  return { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 40, thoughtTokens: 10, totalTokens: 190 } }
})
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
