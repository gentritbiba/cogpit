// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { collectRoutes, createMockReqRes } from "../http-fixtures"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { instanceSessionId } from "../../../shared/session/instances"
import { __resetEditionForTest } from "../../edition"
import { closeCommandDispatcher, commandDispatcher } from "../../lib/durableSend"
import { registerSessionCommandRoutes } from "../../routes/session-commands"

const mocks = vi.hoisted(() => ({ send: vi.fn(), target: "" }))
vi.mock("../../agents/runtimes", async (original) => ({
  ...await original<typeof import("../../agents/runtimes")>(),
  resolveSessionAgent: async (id: string) => ({ kind: id === mocks.target ? "codex" : "claude", instanceId: "default", filePath: null }),
  runtimeFor: () => ({ descriptor: descriptorFor("claude"), send: mocks.send }),
}))
vi.mock("../../sessionPaths", () => ({ findJsonlPath: async () => null }))
vi.mock("../../sessionHosts/localHost", () => ({ localHost: { address: async (id: string) => ({ dirName: "current-project", fileName: `${id}.jsonl` }) } }))
const routes = collectRoutes(registerSessionCommandRoutes)
afterEach(() => { closeCommandDispatcher(); __resetEditionForTest() })

describe("queue mutations after a provider handoff", () => {
  it.each(["default", "account-2"])("rejects a stale native alias after moving to %s", async (instanceId) => {
    __resetEditionForTest()
    mocks.send.mockReset()
    const dispatcher = commandDispatcher()
    const source = "00000000-0000-4000-8000-000000000001"
    const target = instanceSessionId(instanceId, "00000000-0000-4000-8000-000000000002")
    mocks.target = target
    const conversation = dispatcher.store.ensureConversation({ hostId: "local", agent: "claude", instanceId: "default", sessionId: source, nativeSessionId: source })
    dispatcher.close()
    const lease = dispatcher.store.acquire("test-owner", 10_000)!
    dispatcher.store.admit("local", "held-command", conversation.id, { message: "Previous request" })
    dispatcher.store.transition(conversation.id, 1, { hostId: "local", agent: "codex", instanceId, sessionId: target, nativeSessionId: "00000000-0000-4000-8000-000000000002" })
    dispatcher.store.claim("local", "held-command", lease)
    expect(dispatcher.store.command("local", "held-command")?.receipt.state).toBe("held")

    const read = createMockReqRes("GET", `/?sessionId=${source}`)
    await routes.get("/api/session-commands")!(read.req, read.res, read.next)
    expect(JSON.parse(read.res._getData())).toMatchObject({ conversation: { binding: { sessionId: target } }, currentAddress: { dirName: "current-project" } })

    const edit = createMockReqRes("POST", "/", { body: JSON.stringify({ sessionId: source, action: "edit", commandId: "held-command", newCommandId: "replacement", message: "Updated request" }) })
    routes.get("/api/session-commands")!(edit.req, edit.res, edit.next)
    edit.sendBody()
    await vi.waitFor(() => expect(edit.res._getStatus()).toBe(409))
    expect(JSON.parse(edit.res._getData()).error).toContain(target)
    expect(dispatcher.store.command("local", "replacement")).toBeNull()
    expect(dispatcher.store.command("local", "held-command")?.receipt.state).toBe("held")
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
