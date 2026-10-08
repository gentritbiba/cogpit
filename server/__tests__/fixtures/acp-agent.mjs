import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const cancellations = new Map()
let initialized = false
const counterPath = join(process.env.HOME, ".fixture-session-counter")
let nextSession = 0
try { nextSession = Number(readFileSync(counterPath, "utf8")) || 0 } catch {}
const configOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fixture-default", options: [{ value: "fixture-default", name: "Fixture default" }, { value: "fixture-alt", name: "Fixture alternate" }] }]
const app = agent({ name: "cogpit-test-agent" })
app.onRequest("initialize", async () => { await new Promise((resolve) => setTimeout(resolve, 100)); initialized = true; return { protocolVersion: process.argv.includes("--wrong-protocol") ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION, agentCapabilities: { loadSession: !process.argv.includes("--no-load"), promptCapabilities: { image: false } }, agentInfo: { name: "Synthetic ACP", version: "1" } } })
app.onRequest("session/new", () => { if (!initialized) throw new Error("Session created before initialization"); nextSession++; writeFileSync(counterPath, String(nextSession), { mode: 0o600 }); return { sessionId: nextSession === 1 ? "same-native-id" : `native-${nextSession}`, configOptions } })
app.onRequest("session/load", async ({ params, client }) => { await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED-HISTORY" } } }); return { configOptions } })
app.onRequest("session/set_config_option", ({ params }) => ({ configOptions: configOptions.map((option) => ({ ...option, currentValue: params.value })) }))
app.onNotification("session/cancel", ({ params }) => { cancellations.get(params.sessionId)?.({ stopReason: "cancelled" }); cancellations.delete(params.sessionId) })
app.onRequest("session/prompt", async ({ params, client }) => {
  const text = params.prompt.filter((value) => value.type === "text").map((value) => value.text).join("")
  if (text === "wait") return new Promise((resolve) => cancellations.set(params.sessionId, resolve))
  if (text === "crash") process.exit(12)
  if (text === "progress") await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "native-tool-42", status: "in_progress", title: "Fixture progress" } })
  let output = `Echo: ${text}. Home: ${process.env.HOME}`
  if (text === "permission") {
    const response = await client.request("session/request_permission", { sessionId: params.sessionId, toolCall: { toolCallId: "native-tool-42", title: "Synthetic tool" }, options: [{ optionId: "native-allow-42", name: "Allow once", kind: "allow_once" }, { optionId: "native-deny-42", name: "Deny", kind: "reject_once" }] })
    output = JSON.stringify(response)
  }
  await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } } })
  return { stopReason: "end_turn" }
})
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
