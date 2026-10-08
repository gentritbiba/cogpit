import { randomUUID } from "node:crypto"
import { authorizeSession, mayActHostWide, visibilityFor } from "../edition"
import { commandScope } from "../lib/durableSend"
import { runSessionCli } from "../sessionCli/commands"
import { sendJson, withJsonBody, type UseFn } from "../http"

const commands = { session_new: "new", session_send: "send", session_status: "status", session_result: "result", session_answer: "answer", session_tasks: "tasks", session_receipt: "receipt", session_approve: "approve", session_deny: "deny", session_interrupt: "interrupt", session_stop: "stop", session_children: "children", conversation_transition: "transition" } as const
const descriptions: Record<keyof typeof commands, string> = { session_new: "Create a session with durable creation deduplication.", session_send: "Queue, steer or restart a session with a durable receipt.", session_status: "Read session activity and pending requests.", session_result: "Read a session’s final result.", session_answer: "Answer a pending request.", session_tasks: "Read and acknowledge durable delegated results.", session_receipt: "Read a durable delivery receipt.", session_approve: "Approve a pending native permission or plan.", session_deny: "Deny a pending native permission or plan.", session_interrupt: "Interrupt a running turn.", session_stop: "Stop sessions.", session_children: "List child sessions.", conversation_transition: "Resume a compatible native session or create a bounded context handoff." }
const readCommands = new Set(["status", "result", "receipt", "children"])
export function registerSessionMcpRoutes(use: UseFn): void {
  use("/api/session-mcp", (req, res) => {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); sendJson(res, 405, { error: "Use POST for this stateless MCP endpoint" }); return }
    withJsonBody<{ jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }>(req, res, async (body) => {
      const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result })
      const failure = (code: number, message: string) => sendJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, error: { code, message } })
      if (body.jsonrpc !== "2.0") return failure(-32600, "Invalid JSON-RPC request")
      if (body.method?.startsWith("notifications/")) { res.statusCode = 202; res.end(); return }
      if (typeof body.id !== "string" && (typeof body.id !== "number" || !Number.isFinite(body.id))) return failure(-32600, "Requests require an id")
      if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cogpit-sessions", version: "2" } })
      if (body.method === "ping") return reply({})
      if (body.method === "tools/list") return reply({ tools: Object.entries(commands).map(([name]) => ({ name, description: descriptions[name as keyof typeof commands], inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, callerSessionId: { type: "string" }, commandId: { type: "string", description: "Stable ID for this logical action; reuse it on retries." } }, required: ["argv"] } })) })
      if (body.method !== "tools/call") return failure(-32601, "Method not found")
      const name = body.params?.name
      const args = body.params?.arguments as Record<string, unknown> | undefined
      if (typeof name !== "string" || !Object.hasOwn(commands, name) || !args || !Array.isArray(args.argv) || args.argv.length > 100 || args.argv.some((arg) => typeof arg !== "string" || arg.length > 50000)) return failure(-32602, "Unknown tool or invalid argv")
      const command = commands[name as keyof typeof commands]
      const mutating = !readCommands.has(command) && !(command === "tasks" && !(args.argv as string[]).some((arg) => /^--(?:ack|cancel)(?:=|$)/.test(arg)))
      if (mutating && (typeof args.commandId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(args.commandId))) return failure(-32602, "A stable commandId is required for mutations")
      const callerSessionId = typeof args.callerSessionId === "string" ? args.callerSessionId : undefined
      if (callerSessionId && await authorizeSession(req, res, { sessionId: callerSessionId }, "interact") === null) return
      try {
        const argv = [command, ...args.argv as string[]]
        if (["send", "answer", "transition"].includes(command)) argv.push("--command-id", String(args.commandId))
        const result = await runSessionCli({ argv, cwd: typeof args.cwd === "string" ? args.cwd : process.cwd(), callerSessionId, invocationId: typeof args.commandId === "string" ? args.commandId : randomUUID(), scope: commandScope(req), admin: mayActHostWide(req), visible: visibilityFor(req), req })
        reply({ content: [{ type: "text", text: result.stdout || result.stderr }], isError: result.exitCode !== 0 })
      } catch (error) { failure(-32000, error instanceof Error ? error.message : "Session tool failed") }
    })
  })
}
