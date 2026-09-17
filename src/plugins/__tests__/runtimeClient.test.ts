import { createElement, StrictMode, type ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("../browserSupport", () => ({ getPluginBrowserSupport: () => ({ supported: true, browser: ["message-channel", "blob-script", "web-crypto"], missing: [], error: null }) }))
import { authFetch } from "@/lib/auth"
import { __resetDeviceRevisionsForTest, __resetIdentityForTest, recordDeviceConnectionRevision, setActiveIdentity, switchDevice } from "@/lib/device"
import { clientRuntimeDescriptor, EMPTY_PLUGIN_STATE, RuntimePluginClient } from "../runtimeClient"
import { useRuntimePlugins } from "../useRuntimePlugins"
import type { PluginHostStatus } from "../../../shared/contracts/pluginManagement"

const fetchMock = vi.mocked(authFetch)
const clients: RuntimePluginClient[] = []
const limit = 4 * 1024 * 1024
interface FetchCall { url: URL; method: string; headers: Headers; signal: AbortSignal }
let calls: FetchCall[]
let respond: (request: FetchCall) => Response | Promise<Response>
let sessionNumber: number
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const sessionId = (number: number) => number.toString(16).padStart(64, "0")
function status(revision = 1, instanceId = "host-a"): PluginHostStatus {
  return {
    runtime: { appVersion: "2.6.6", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "linux", registryRevision: revision },
    host: { name: "Fixture host", instanceId },
    store: { available: true, revision, plugins: [], publishers: [] }, projects: [], safeMode: false,
  }
}
function fallback(request: FetchCall): Response {
  if (request.url.pathname.endsWith("/session")) return json(request.method === "DELETE" ? { ok: true } : { sessionId: sessionId(++sessionNumber), expiresAt: Date.now() + 60_000 })
  if (request.url.pathname.endsWith("/status")) return json(status())
  if (request.url.pathname.endsWith("/leases")) return json({ id: "fixture-lease", expiresAt: Date.now() + 30_000 })
  throw new Error(`Unexpected fixture request ${request.method} ${request.url.pathname}`)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function createClient() { const client = new RuntimePluginClient(); clients.push(client); client.start(); return client }
async function ready(client: RuntimePluginClient) { await client.refresh(); expect(client.getSnapshot().status).not.toBeNull() }

beforeEach(() => {
  window.history.replaceState(null, "", "/d/host-a/")
  __resetIdentityForTest(); __resetDeviceRevisionsForTest()
  calls = []; sessionNumber = 0; respond = fallback
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const request = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), signal: init?.signal as AbortSignal }
    calls.push(request)
    return respond(request)
  })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.stop()
  vi.restoreAllMocks()
  __resetIdentityForTest(); __resetDeviceRevisionsForTest()
  window.history.replaceState(null, "", "/")
})

describe("runtime plugin client host and session ownership", () => {
  it("captures the target URL and revokes the old session on a host switch", async () => {
    const client = createClient()
    await ready(client)
    switchDevice("host-b")
    expect(client.getSnapshot()).toEqual(EMPTY_PLUGIN_STATE)
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
    expect(calls.at(-1)!.url.pathname).toBe("/hub/host-a/api/plugins/session")
    expect(calls.at(-1)!.headers.get("X-Cogpit-Plugin-Session")).toBe(sessionId(1))
    await expect(client.changeInstalled("dev.fixture", "enabled", { enabled: false }, 1)).rejects.toThrow()
    expect(calls.every((call) => call.url.pathname.startsWith("/hub/host-a/api/plugins/"))).toBe(true)
  })

  it.each(["identity", "connection"])("clears state and aborts pending work when the active %s changes", async (change) => {
    const client = createClient()
    await ready(client)
    const pending = deferred<Response>()
    respond = (request) => request.url.pathname.endsWith("/enabled") ? pending.promise : fallback(request)
    const mutation = client.changeInstalled("dev.fixture", "enabled", { enabled: false }, 1)
    const rejected = expect(mutation).rejects.toThrow()
    await waitFor(() => expect(calls.at(-1)!.url.pathname).toContain("/enabled"))
    const signal = calls.at(-1)!.signal
    if (change === "identity") setActiveIdentity("another-user")
    else recordDeviceConnectionRevision("host-a", 2)
    expect(signal.aborted).toBe(true)
    pending.resolve(json(status(99).store))
    await rejected
    expect(client.getSnapshot()).toEqual(EMPTY_PLUGIN_STATE)
  })

  it("does not publish a body that finishes after the host changes", async () => {
    const client = createClient()
    await ready(client)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    respond = (request) => request.url.pathname.endsWith("/status") ? new Response(new ReadableStream({ start(controller) { stream = controller } })) : fallback(request)
    const refresh = client.refresh()
    await waitFor(() => expect(stream).toBeDefined())
    switchDevice("host-b")
    stream.enqueue(new TextEncoder().encode(JSON.stringify(status(99))))
    stream.close()
    await refresh
    expect(client.getSnapshot()).toEqual(EMPTY_PLUGIN_STATE)
  })

  it("survives start-stop-start without an old mint replacing the new session", async () => {
    const old = deferred<Response>()
    let mintCount = 0
    respond = (request) => request.method === "POST" && request.url.pathname.endsWith("/session") && ++mintCount === 1 ? old.promise : fallback(request)
    const client = createClient()
    const oldRefresh = client.refresh()
    const oldSignal = calls[0]!.signal
    client.stop(); client.start()
    await ready(client)
    const current = client.getSnapshot()
    old.resolve(json({ sessionId: sessionId(99), expiresAt: Date.now() + 60_000 }))
    await oldRefresh
    expect(oldSignal.aborted).toBe(true)
    expect(client.getSnapshot()).toEqual(current)
    expect(client.getSnapshot().activation).toContain(sessionId(1))
  })

  it("revokes a session whose mint completed after the client stopped", async () => {
    const minted = deferred<Response>()
    respond = (request) => request.method === "POST" && request.url.pathname.endsWith("/session") ? minted.promise : fallback(request)
    const client = createClient()
    const pending = client.refresh()
    client.stop()
    switchDevice("host-b")
    minted.resolve(json({ sessionId: sessionId(99), expiresAt: Date.now() + 60_000 }))
    await pending
    expect(calls.some((call) => call.method === "DELETE" && call.headers.get("X-Cogpit-Plugin-Session") === sessionId(99))).toBe(true)
    expect(calls.every((call) => call.url.pathname.startsWith("/hub/host-a/api/plugins/"))).toBe(true)
  })

  it("starts the hook under StrictMode and stops polling when disabled", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children)
    const { result, rerender, unmount } = renderHook(({ enabled }) => useRuntimePlugins(enabled), { initialProps: { enabled: true }, wrapper })
    await waitFor(() => expect(result.current.status?.host.instanceId).toBe("host-a"))
    const sameClient = result.current.client
    act(() => rerender({ enabled: false }))
    expect(result.current.status).toBeNull()
    expect(result.current.client).toBe(sameClient)
    expect(calls.at(-1)!.method).toBe("DELETE")
    act(() => rerender({ enabled: true }))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    unmount()
    expect(calls.at(-1)!.method).toBe("DELETE")
  })

  it("shares concurrent session creation and renews before expiry with the existing handle", async () => {
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const minted = deferred<Response>()
    respond = (request) => request.method === "POST" && request.url.pathname.endsWith("/session") ? minted.promise : fallback(request)
    const client = createClient()
    const lease = client.lease("dev.fixture", null, "epoch", new AbortController().signal)
    expect(calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/session"))).toHaveLength(1)
    minted.resolve(json({ sessionId: sessionId(1), expiresAt: now + 60_000 }))
    await ready(client); await lease
    now += 36_000
    respond = fallback
    await client.refresh()
    const mints = calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/session"))
    expect(mints).toHaveLength(2)
    expect(mints[1]!.headers.get("X-Cogpit-Plugin-Session")).toBe(sessionId(1))
    expect(mints.every(mint => mint.headers.get("Content-Type") === "application/json")).toBe(true)
    const mintRequests = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
    expect(mintRequests.every(([, init]) => JSON.parse(String(init!.body)).client.appVersion === clientRuntimeDescriptor().appVersion)).toBe(true)
    expect(JSON.parse(String(mintRequests.at(-1)![1]!.body))).toEqual({ client: clientRuntimeDescriptor() })
  })

  it("drops an expired session handle before the next session creation", async () => {
    const client = createClient()
    await ready(client)
    respond = (request) => request.url.pathname.endsWith("/status") ? json({ code: "STALE_ACTIVATION", error: "Session expired" }, 409) : fallback(request)
    await client.refresh()
    expect(client.getSnapshot()).toMatchObject({ status: null, error: "Session expired", activation: "" })
    respond = fallback
    await ready(client)
    const mint = calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/session")).at(-1)!
    expect(mint.headers.has("X-Cogpit-Plugin-Session")).toBe(false)
    expect(client.getSnapshot().activation).toContain(sessionId(2))
  })

  it("does not let an older refresh overwrite a completed mutation revision", async () => {
    const client = createClient()
    await ready(client)
    const old = deferred<Response>()
    respond = (request) => request.url.pathname.endsWith("/status") ? old.promise : request.url.pathname.endsWith("/enabled") ? json(status(2).store) : fallback(request)
    const refresh = client.refresh()
    const mutation = client.changeInstalled("dev.fixture", "enabled", { enabled: false }, 1)
    await waitFor(() => expect(client.getSnapshot().status?.store.revision).toBe(2))
    old.resolve(json(status(1)))
    await refresh; await mutation
    expect(client.getSnapshot().status?.store.revision).toBe(2)
    expect(client.getSnapshot().status?.runtime.registryRevision).toBe(2)
  })
})

describe("runtime plugin response and upload limits", () => {
  it.each(["declared", "streamed"])("rejects %s oversized status bodies", async (kind) => {
    const cancel = vi.fn()
    respond = (request) => request.url.pathname.endsWith("/status") ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)) }, cancel }), { headers: kind === "declared" ? { "Content-Length": String(limit + 1) } : {} }) : fallback(request)
    const client = createClient()
    await client.refresh()
    expect(client.getSnapshot()).toMatchObject({ status: null, error: "Plugin response exceeds its size limit" })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects oversized payload streams and cancels the response reader", async () => {
    const client = createClient()
    await ready(client)
    const cancel = vi.fn()
    respond = (request) => request.url.pathname.includes("/payload/") ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)) }, cancel })) : fallback(request)
    await expect(client.payload("candidate")).rejects.toThrow(/size limit/)
    expect(cancel).toHaveBeenCalledOnce()
    await expect(client.stage(new Blob([new Uint8Array(limit + 1)]), { type: "all" })).rejects.toThrow(/4 MiB/)
    expect(calls.some((call) => call.url.pathname.endsWith("/stage"))).toBe(false)
  })

  it("rejects invalid UTF-8 and malformed status envelopes", async () => {
    const client = createClient()
    await ready(client)
    respond = (request) => request.url.pathname.endsWith("/status") ? new Response(new Uint8Array([0xff])) : fallback(request)
    await client.refresh()
    expect(client.getSnapshot()).toMatchObject({ status: null, activation: "" })
    respond = (request) => request.url.pathname.endsWith("/status") ? json({ ...status(), unexpected: "field" }) : fallback(request)
    await client.refresh()
    expect(client.getSnapshot().status).toBeNull()
  })

  it("forwards cancellation and discards payload bytes after caller cancellation", async () => {
    const client = createClient()
    await ready(client)
    const response = deferred<Response>()
    respond = (request) => request.url.pathname.includes("/payload/") ? response.promise : fallback(request)
    const abort = new AbortController()
    const pending = client.payload("candidate/escaped", abort.signal)
    const rejected = expect(pending).rejects.toThrow()
    await waitFor(() => expect(calls.at(-1)!.url.pathname).toContain("candidate%2Fescaped"))
    const signal = calls.at(-1)!.signal
    abort.abort()
    expect(signal.aborted).toBe(true)
    response.resolve(new Response(new Uint8Array([1, 2, 3])))
    await rejected
    expect(client.getSnapshot().status).not.toBeNull()
  })
})
