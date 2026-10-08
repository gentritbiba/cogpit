#!/usr/bin/env node
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout))
const sessions = new Map()
const path = (id) => join(process.env.COPILOT_HOME, "session-state", id, "events.jsonl")
connection.onRequest(async (method, params) => {
  if (method === "connect") return { ok: true, protocolVersion: 3 }
  if (method === "session.create") {
    sessions.set(params.sessionId, params.workingDirectory)
    mkdirSync(join(process.env.COPILOT_HOME, "session-state", params.sessionId), { recursive: true })
    writeFileSync(path(params.sessionId), JSON.stringify({ type: "session.start", data: { context: { cwd: params.workingDirectory } } }) + "\n")
    return { sessionId: params.sessionId }
  }
  if (method === "session.send") {
    void connection.sendRequest("exitPlanMode.request", { sessionId: params.sessionId, summary: "Synthetic account plan", planContent: "Use the owning account", actions: ["interactive", "autopilot"], recommendedAction: "interactive" }).then((answer) => {
      appendFileSync(path(params.sessionId), JSON.stringify({ type: "fixture.plan_answer", data: answer }) + "\n")
      connection.sendNotification("session.event", { sessionId: params.sessionId, event: { type: "session.idle", data: {} } })
    }).catch(() => {})
    return { messageId: "fixture-message" }
  }
  if (method === "session.permissions.setAllowAll" || method === "session.permissions.setMode") return { success: true }
  if (method === "session.delete") return { success: true }
  if (method === "sessions.checkInUse") return { inUse: [] }
  if (method === "models.list") return { models: [] }
  return null
})
connection.listen()
