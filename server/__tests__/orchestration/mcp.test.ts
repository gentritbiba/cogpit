// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
const run = vi.hoisted(() => vi.fn())
vi.mock("../../sessionCli/commands", () => ({ runSessionCli: run }))
import { registerSessionMcpRoutes } from "../../routes/session-mcp"

async function call(body: unknown, method = "POST") {
  const handler = getRouteHandler(collectRoutes(registerSessionMcpRoutes), "/api/session-mcp")
  const { req, res, next, sendBody } = createMockReqRes(method, "/", { body: JSON.stringify(body) })
  handler(req, res, next); sendBody()
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
  return { status: res._getStatus(), body: JSON.parse(res._getData() || "null") }
}
beforeEach(() => { run.mockReset().mockResolvedValue({ exitCode: 0, stdout: "{}", stderr: "" }) })
describe("stateless session MCP", () => {
  it("initializes and advertises session receipts, permissions and durable tasks", async () => {
    expect((await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).body.result.protocolVersion).toBe("2025-03-26")
    const result = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(result.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["session_receipt", "session_approve", "session_tasks"]))
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)
    expect((await call({}, "GET")).status).toBe(405)
  })
  it("requires IDs for mutations, refuses prototype names and freezes the authoritative command ID", async () => {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_send", arguments: { argv: ["native", "Hello"] } } }
    expect((await call(request)).body.error.code).toBe(-32602)
    expect((await call({ ...request, params: { ...request.params, name: "__proto__" } })).body.error.code).toBe(-32602)
    expect(run).not.toHaveBeenCalled()
    const arguments_ = { argv: ["native", "Hello", "--command-id", "untrusted-override"], commandId: "immutable-command-id" }
    expect((await call({ ...request, params: { ...request.params, arguments: arguments_ } })).body.result.isError).toBe(false)
    expect(run.mock.calls[0][0]).toMatchObject({ invocationId: "immutable-command-id", argv: ["send", ...arguments_.argv, "--command-id", "immutable-command-id"] })
  })
})
