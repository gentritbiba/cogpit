// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { CONTRACT_LIMITS, parseConnectionDefinition } from "@cogpit/plugin-contracts"
import { createConnectionExecutor, CONNECTION_LIMITS, type ConnectionTransport, type HostConnection } from "../../plugins/connectionExecutor"
import type { PluginHttpsInput } from "../../plugins/httpsTransport"
import clickup from "./fixtures/connections/clickup.json"
import figma from "./fixtures/connections/figma-input.json"
import unknown from "./fixtures/connections/unknown.json"

const secret = "fixture-pk-private-credential"
const connection: HostConnection = {
  label: "Work account", secret, identity: { viewer: "7" },
  selected: { workspace: { id: "100", label: "Work" }, space: { id: "200", label: "Engineering" }, list: { id: "300", label: "Backlog" } },
}
const executor = (transport: ConnectionTransport, state = connection, signal?: AbortSignal) => createConnectionExecutor(clickup, state, { transport, allowedOperations: ["mine", "tasks"], signal })

function provider(input: PluginHttpsInput): unknown {
  const path = new URL(input.path, input.origin).pathname
  if (path === "/api/v2/user") return { user: { id: 7, username: "Viewer" } }
  if (path === "/api/v2/team") return { teams: [{ id: 100, name: "Work" }, { id: 101, name: "Personal" }] }
  if (path === "/api/v2/team/100/space") return { spaces: [{ id: 200, name: "Engineering" }, { id: 201, name: "Design" }] }
  if (path === "/api/v2/space/200/list") return { lists: [{ id: 300, name: "Backlog" }] }
  if (path === "/api/v2/space/200/folder") return { folders: [{ id: 400, name: "Release", lists: [{ id: 301, name: "Bugs" }] }] }
  if (path === "/api/v2/list/301") return { id: "301", name: "Bugs", space: { id: "200" } }
  return { tasks: [], last_page: true }
}

describe("host-owned ClickUp resources and identity", () => {
  it("validates the credential identity, then fixes My tasks to that viewer and selected workspace", async () => {
    const send = vi.fn(async (input: PluginHttpsInput) => provider(input))
    const initial = executor(send, { ...connection, identity: {} })
    expect(await initial.validate()).toEqual({ ok: true, data: { identity: { viewer: "7" } } })
    expect(await initial.request({ operation: "mine", args: {} })).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    const active = executor(send)
    expect((await active.request({ operation: "mine", args: { page: 2 } })).ok).toBe(true)
    const request = send.mock.calls.at(-1)![0], url = new URL(request.path, request.origin)
    expect(url.pathname).toBe("/api/v2/team/100/task")
    expect(Object.fromEntries(url.searchParams)).toEqual({ "assignees[]": "7", include_closed: "false", subtasks: "true", order_by: "due_date", reverse: "true", page: "2" })
    expect(request.credential).toEqual({ header: "Authorization", scheme: "raw", secret })
    for (const args of [{ viewer: "8" }, { workspace: "101" }, { "assignees[]": "8" }, { page: 3 }]) {
      expect(await active.request({ operation: "mine", args })).toEqual({ ok: false, error: "INVALID_REQUEST" })
    }
    expect(send).toHaveBeenCalledTimes(2)
  })
  it("merges folderless and nested folder lists using selected parent resources", async () => {
    const send = vi.fn(async (input: PluginHttpsInput) => provider(input))
    expect(await executor(send).listOptions("list")).toEqual({ ok: true, data: [{ id: "300", label: "Backlog" }, { id: "301", label: "Bugs" }] })
    expect(send.mock.calls.map(([input]) => input.path)).toEqual(["/api/v2/space/200/list?archived=false", "/api/v2/space/200/folder?archived=false"])
  })
  it.each(["301", "https://app.clickup.com/100/v/li/301", "https://app.clickup.com/100/v/li/301?origin=https://evil.test#ignored"])("validates entered List %s and proves its selected Space", async (input) => {
    const send = vi.fn(async (input: PluginHttpsInput) => provider(input))
    const result = await executor(send).selectResource("list", input)
    expect(result).toEqual({ ok: true, data: { ...connection.selected, list: { id: "301", label: "Bugs" } } })
    expect(send.mock.calls[0][0].path).toBe("/api/v2/list/301")
    expect(send).toHaveBeenCalledTimes(1)
  })
  it.each([
    { id: "301", name: "Other space", space: { id: "999" } },
    { id: "302", name: "Other List", space: { id: "200" } },
    { id: "301", name: "Missing parent" },
    { id: "301", space: { id: "200" } },
  ])("rejects a candidate whose response does not prove ID, label and parent", async (response) => {
    expect(await executor(async () => response).selectResource("list", "301")).toEqual({ ok: false, error: "INVALID_RESPONSE" })
  })
  it("still accepts listed IDs when a resource also permits URL-only entry", async () => {
    const definition = parseConnectionDefinition(clickup)
    definition.resources.list.input!.allowId = false
    const send = vi.fn(async (input: PluginHttpsInput) => provider(input))
    const active = createConnectionExecutor(definition, connection, { transport: send, allowedOperations: ["mine", "tasks"] })
    expect(await active.selectResource("list", "300")).toEqual({ ok: true, data: connection.selected })
    expect(send.mock.calls.map(([input]) => input.path)).toEqual(["/api/v2/space/200/list?archived=false", "/api/v2/space/200/folder?archived=false"])
  })
  it("discovers declared parents for legacy setup without selecting or authorizing them", async () => {
    const send = vi.fn(async (input: PluginHttpsInput) => provider(input))
    const active = executor(send, { ...connection, selected: {} })
    expect(await active.resolveResourceInput("list", "301")).toEqual({ ok: true, data: { selection: { id: "301", label: "Bugs" }, parents: { space: "200" } } })
    expect(active.publicState().selected).toEqual({})
    expect(await active.selectResource("list", "301")).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    expect(await active.request({ operation: "tasks", args: {} })).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    expect(await active.request({ operation: "validateList", args: { candidate: "301" } })).toEqual({ ok: false, error: "INVALID_REQUEST" })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it("changing an ancestor removes every descendant without mutating the captured snapshot", async () => {
    const active = executor(async (input) => provider(input))
    expect(await active.selectResource("workspace", "101")).toEqual({ ok: true, data: { workspace: { id: "101", label: "Personal" } } })
    expect(await active.selectResource("space", "201")).toEqual({ ok: true, data: { workspace: connection.selected.workspace, space: { id: "201", label: "Design" } } })
    expect(await active.selectResource("workspace", null)).toEqual({ ok: true, data: {} })
    expect(await active.selectResource("space", null)).toEqual({ ok: true, data: { workspace: connection.selected.workspace } })
    expect(active.publicState().selected).toEqual(connection.selected)
  })
  it("selection IDs must appear in fresh host-listed choices; caller labels are not accepted", async () => {
    const send = vi.fn(async () => ({ teams: [{ id: "100", name: "Renamed workspace" }] }))
    expect(await executor(send).selectResource("workspace", "101")).toEqual({ ok: false, error: "INVALID_REQUEST" })
    expect(await executor(send).selectResource("workspace", "100")).toEqual({ ok: true, data: { ...connection.selected, workspace: { id: "100", label: "Renamed workspace" } } })
    expect(await executor(send).selectResource("workspace", { id: "100", label: "Forged" } as unknown as string)).toEqual({ ok: false, error: "INVALID_REQUEST" })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it("missing or orphaned parents block dependent options and panel calls before transport", async () => {
    const send = vi.fn(async () => ({})), active = executor(send, { ...connection, selected: { list: connection.selected.list } })
    expect(await active.listOptions("list")).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    expect(await active.request({ operation: "tasks", args: {} })).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    expect(await active.selectResource("list", "301")).toEqual({ ok: false, error: "RESOURCE_REQUIRED" })
    expect(send).not.toHaveBeenCalled()
  })
  it("enforces the trusted operation allowlist independently of the signed panel audience", async () => {
    const send = vi.fn(async () => ({})), allowed = ["mine"]
    const active = createConnectionExecutor(clickup, connection, { transport: send, allowedOperations: allowed })
    allowed.push("tasks")
    for (const operation of ["tasks", "validate", "validateList", "workspaces"]) {
      expect(await active.request({ operation, args: {} })).toEqual({ ok: false, error: "INVALID_REQUEST" })
    }
    expect(send).not.toHaveBeenCalled()
    expect(() => createConnectionExecutor(clickup, connection, { transport: send, allowedOperations: ["validate"] })).toThrow("INVALID_REQUEST")
  })
  it.each([
    { lists: [{ id: "300", name: "Duplicate" }] },
    { folders: [{ lists: "not an array" }] },
    { folders: Array.from({ length: CONNECTION_LIMITS.options + 1 }, () => ({ lists: [] })) },
  ])("rejects malformed nested options and duplicates across sources", async (bad) => {
    const send = async (input: PluginHttpsInput) => input.path.includes("/folder") ? ("lists" in bad ? { folders: [bad] } : bad) : { lists: [{ id: "300", name: "Backlog" }] }
    expect(await executor(send).listOptions("list")).toEqual({ ok: false, error: "INVALID_RESPONSE" })
  })
})

describe("validated Figma input without an echoed file key", () => {
  const state: HostConnection = { label: "Design", secret, selected: {} }
  const create = (transport: ConnectionTransport) => createConnectionExecutor(figma, state, { transport, allowedOperations: ["file", "nodes"] })
  it.each(["Abc123", "https://www.figma.com/design/Abc123/Project?node-id=1-2", "https://www.figma.com/file/Abc123/Project", "https://www.figma.com/board/Abc123/Project"])("validates candidate %s through fixed API path and required name", async (input) => {
    const send = vi.fn(async () => ({ name: "Design system", document: { id: "0:0", type: "DOCUMENT" } }))
    expect(await create(send).selectResource("file", input)).toEqual({ ok: true, data: { file: { id: "Abc123", label: "Design system" } } })
    expect(send.mock.calls[0]?.length).toBe(1)
    const request = (send.mock.calls[0] as unknown as [PluginHttpsInput])[0]
    expect(request.origin + request.path).toBe("https://api.figma.com/v1/files/Abc123?depth=1")
  })
  it.each([
    "https://evil.test/design/Abc123/Project", "https://www.figma.com.evil.test/design/Abc123/Project",
    "https://user@www.figma.com/design/Abc123/Project", "http://www.figma.com/design/Abc123/Project",
    "https://www.figma.com/design", "https://www.figma.com/design/Abc123/design/Other", "https://www.figma.com/?file=Abc123",
    "https://www.figma.com/design/Abc123/../Other", "https://www.figma.com/design/%2e%2e/Project", "https://www.figma.com/design/A%2fB/Project",
    "https://www.figma.com/design/A%252fB/Project", "https://www.figma.com/design/A\\B/Project", "../file", "%2e%2e", "a/b",
  ])("rejects unsafe or undeclared extraction %s before transport", async (input) => {
    const send = vi.fn(async () => ({ name: "Safe" }))
    expect(await create(send).selectResource("file", input)).toEqual({ ok: false, error: "INVALID_REQUEST" })
    expect(send).not.toHaveBeenCalled()
  })
  it("validates file name presence and never emits a credential echo", async () => {
    expect(await create(async () => ({ document: {} })).selectResource("file", "Abc123")).toEqual({ ok: false, error: "INVALID_RESPONSE" })
    expect(await create(async () => ({ name: secret })).selectResource("file", "Abc123")).toEqual({ ok: false, error: "INVALID_RESPONSE" })
  })
})

describe("cancellation, result bounds and provider independence", () => {
  it("aborts before transport and rejects a late result after in-flight cancellation", async () => {
    const already = new AbortController(); already.abort()
    const untouched = vi.fn(async () => ({}))
    expect(await executor(untouched, connection, already.signal).request({ operation: "mine", args: {} })).toEqual({ ok: false, error: "CANCELED" })
    expect(untouched).not.toHaveBeenCalled()
    const controller = new AbortController()
    let finish!: (value: unknown) => void
    const send = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const pending = executor(send, connection, controller.signal).request({ operation: "mine", args: {} })
    await Promise.resolve(); controller.abort()
    expect(await pending).toEqual({ ok: false, error: "CANCELED" })
    finish({ tasks: ["late"] })
  })
  it("checks cancellation when transport resolves and while collecting multiple option sources", async () => {
    const controller = new AbortController(), send = vi.fn(async () => { controller.abort(); return { tasks: [] } })
    expect(await executor(send, connection, controller.signal).request({ operation: "mine", args: {} })).toEqual({ ok: false, error: "CANCELED" })
    const next = new AbortController(), multiple = vi.fn(async () => { next.abort(); return { lists: [] } })
    expect(await executor(multiple, connection, next.signal).listOptions("list")).toEqual({ ok: false, error: "CANCELED" })
    expect(multiple).toHaveBeenCalledTimes(1)
  })
  it("accepts a realistic bounded 100-task page and rejects byte/node/depth overflow", async () => {
    const tasks = { tasks: Array.from({ length: 100 }, (_, index) => ({ id: String(index), name: "Task", description: "a".repeat(1000), assignees: [{ id: 7, username: "Viewer" }] })) }
    expect(JSON.stringify(tasks).length).toBeGreaterThan(65536)
    expect(await executor(async () => tasks).request({ operation: "mine", args: {} })).toEqual({ ok: true, data: tasks })
    for (const value of [{ data: "a".repeat(CONTRACT_LIMITS.responseBytes) }, Array.from({ length: CONTRACT_LIMITS.responseNodes }, () => null), JSON.parse("[".repeat(17) + "null" + "]".repeat(17))]) {
      expect(await executor(async () => value).request({ operation: "mine", args: {} })).toEqual({ ok: false, error: "INVALID_RESPONSE" })
    }
  })
  it.each(["CANCELED", "TIMEOUT", "NETWORK_DENIED", "INVALID_RESPONSE"])("only exposes static transport failure code %s", async (code) => {
    const result = await executor(async () => { throw Object.assign(new Error(secret), { code }) }).request({ operation: "mine", args: {} })
    expect(result).toEqual({ ok: false, error: code })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it("unknown providers use the same entered-resource, identity and query mechanism", async () => {
    const definition = parseConnectionDefinition(unknown)
    definition.identity = { viewer: "/principal/id" }
    definition.resources.space.input = { allowId: true, urls: [{ origin: "https://meridian.test", pathMarker: "spaces" }],
      validation: { operation: "validateSpace", argument: "candidate", id: "/key", label: "/title" } }
    definition.operations.validateSpace = { audience: "setup", origin: "https://api.meridian.test", method: "GET", path: [{ literal: "v1" }, { literal: "spaces" }, { arg: "candidate" }],
      args: { candidate: { type: "string", required: true, maxLength: 128 } }, query: { viewer: { identity: "viewer" } } }
    const send = vi.fn(async () => ({ key: "space-b", title: "Selected space" }))
    const active = createConnectionExecutor(definition, { label: "Other service", secret, selected: {}, identity: { viewer: "person-a" } }, { transport: send, allowedOperations: ["document"] })
    expect(await active.selectResource("space", "https://meridian.test/spaces/space-b")).toEqual({ ok: true, data: { space: { id: "space-b", label: "Selected space" } } })
    expect((send.mock.calls[0] as unknown as [PluginHttpsInput])[0].path).toBe("/v1/spaces/space-b?viewer=person-a")
  })
})
