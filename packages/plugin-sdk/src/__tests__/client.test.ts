// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPluginClient, type PluginClient } from "../index.js"
import type { PluginContext } from "@cogpit/plugin-contracts"

class TestPort extends EventTarget {
  sent: unknown[] = []
  closed = false
  started = false
  postMessage(value: unknown) { if (this.closed) throw new Error("closed"); this.sent.push(structuredClone(value)) }
  start() { this.started = true }
  close() { this.closed = true }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: value })) }
  reply(index: number, value: unknown) {
    const request = this.sent[index] as { id: string }
    this.receive({ protocol: 1, type: "result", id: request.id, value })
  }
}
const context: PluginContext = { project: { id: "project1", name: "Project" }, theme: { mode: "dark", tokens: { "--background": "#000" } }, locale: "en", reducedMotion: false, visible: true }
const clients = new Set<PluginClient>()
function fixture(timeoutMs?: number) {
  const port = new TestPort()
  const client = createPluginClient({ port: port as unknown as MessagePort, context, timeoutMs })
  clients.add(client)
  return { port, client }
}
afterEach(() => { for (const client of clients) client.dispose(); clients.clear(); vi.useRealTimers() })

describe("plugin client", () => {
  it("uses the supplied port and sends readiness exactly once", async () => {
    const { port, client } = fixture()
    expect(port.started).toBe(true)
    const first = client.ready(), second = client.ready()
    expect(first).toBe(second)
    expect(port.sent).toEqual([{ protocol: 1, type: "request", id: "r_1", method: "lifecycle.ready", params: {} }])
    port.reply(0, null)
    await expect(first).resolves.toBeNull()
    await client.ready()
    expect(port.sent).toHaveLength(1)
  })
  it("correlates concurrent typed calls and ignores duplicate/unknown responses", async () => {
    const { port, client } = fixture()
    const read = client.storage.get("setting"), write = client.storage.set("setting", { theme: "dark" })
    port.reply(1, null); port.reply(0, { theme: "light" }); port.reply(0, "late")
    port.receive({ protocol: 1, type: "result", id: "unknown", value: null })
    await expect(read).resolves.toEqual({ theme: "light" })
    await expect(write).resolves.toBeNull()
    expect(port.closed).toBe(false)
  })
  it("constructs bounded connection and navigation operations", async () => {
    const { port, client } = fixture()
    const calls = [client.connections.request("connection1", "files.read", { depth: 1 }), client.composer.append("Draft"), client.navigation.openSession("session1"), client.navigation.openExternal("https://example.com"), client.storage.delete("setting")]
    expect(port.sent.map((entry) => (entry as { method: string }).method)).toEqual(["connections.request", "composer.append", "navigation.openSession", "navigation.openExternal", "storage.delete"])
    calls.forEach((_, index) => port.reply(index, null))
    await Promise.all(calls)
    await expect(client.navigation.openExternal("javascript:alert(1)")).rejects.toThrow()
    await expect(client.composer.append("x".repeat(20000))).rejects.toThrow()
  })
  it("sends typed integration operations and rejects malformed result envelopes", async () => {
    const { port, client } = fixture()
    const request = client.integrations.request({ integration: "github", operation: "pulls", limit: 15 })
    expect(port.sent[0]).toMatchObject({ method: "integrations.request", params: { integration: "github", operation: "pulls", limit: 15 } })
    port.reply(0, { ok: true, data: { pulls: [] } })
    await expect(request).resolves.toEqual({ ok: true, data: { pulls: [] } })
    const invalid = client.integrations.request({ integration: "vercel", operation: "deployments" })
    const failure = expect(invalid).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    port.reply(1, { error: "unstructured" })
    await failure
  })
  it("rejects invalid results and propagates structured host errors", async () => {
    const { port, client } = fixture()
    const write = client.storage.set("setting", true)
    const failure = expect(write).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    port.reply(0, { arbitrary: "data" }); await failure
    const read = client.storage.get("setting")
    const denied = expect(read).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
    port.receive({ protocol: 1, type: "error", id: "r_2", error: { code: "CAPABILITY_UNAVAILABLE", message: "Unavailable" } })
    await denied
  })
  it("cancels via AbortSignal and ignores the late response", async () => {
    const { port, client } = fixture()
    const controller = new AbortController()
    const pending = client.storage.get("setting", { signal: controller.signal })
    const canceled = expect(pending).rejects.toMatchObject({ code: "CANCELED" })
    controller.abort(); port.reply(0, "late")
    await canceled
    expect(port.sent[1]).toEqual({ protocol: 1, type: "cancel", id: "r_1" })
    await expect(client.storage.get("setting", { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELED" })
    expect(port.sent).toHaveLength(2)
  })
  it("bounds outstanding requests and cancels them on disposal", async () => {
    const { port, client } = fixture()
    const pending = Array.from({ length: 32 }, () => client.storage.get("setting").catch((error: unknown) => error))
    await expect(client.storage.get("overflow")).rejects.toMatchObject({ code: "RATE_LIMITED" })
    client.dispose()
    expect(port.closed).toBe(true)
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: "DISPOSED" })
    await expect(client.ready()).rejects.toMatchObject({ code: "DISPOSED" })
  })
  it("sends timeout cancellation and releases capacity", async () => {
    vi.useFakeTimers()
    const { port, client } = fixture(50)
    const pending = client.storage.get("setting")
    const timedOut = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" })
    await vi.advanceTimersByTimeAsync(50); await timedOut
    expect(port.sent[1]).toEqual({ protocol: 1, type: "cancel", id: "r_1" })
    const next = client.storage.get("next"); port.reply(2, true)
    await expect(next).resolves.toBe(true)
  })
  it("replaces immutable context and cancels prior work before notifying", async () => {
    const { port, client } = fixture()
    const listener = vi.fn(), themeListener = vi.fn(), visibilityListener = vi.fn()
    const unsubscribe = client.onContextChange(listener)
    client.onThemeChange(themeListener); client.onVisibilityChange(visibilityListener)
    const pending = client.storage.get("setting")
    const stale = expect(pending).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    const next = { ...context, project: { id: "project2", name: "Other project" }, visible: false }
    port.receive({ protocol: 1, type: "event", event: "context", value: next })
    await stale; await Promise.resolve()
    expect(client.context).toEqual(next)
    expect(Object.isFrozen(client.context.theme.tokens)).toBe(true)
    expect(listener).toHaveBeenCalledWith(next)
    expect(themeListener).toHaveBeenCalledWith(next.theme)
    expect(visibilityListener).toHaveBeenCalledWith(false)
    unsubscribe()
    port.receive({ protocol: 1, type: "event", event: "context", value: context })
    await Promise.resolve(); expect(listener).toHaveBeenCalledTimes(1)
  })
  it("updates theme and visibility separately without canceling active requests", async () => {
    const { port, client } = fixture()
    const pending = client.storage.get("setting")
    port.receive({ protocol: 1, type: "event", event: "theme", value: { mode: "light", tokens: {} } })
    port.receive({ protocol: 1, type: "event", event: "visibility", value: false })
    expect(client.context.theme.mode).toBe("light")
    expect(client.context.visible).toBe(false)
    port.reply(0, true); await expect(pending).resolves.toBe(true)
  })
  it.each([
    { protocol: 2, type: "result", id: "r_1", value: null },
    { protocol: 1, type: "request", id: "r_1", method: "storage.get", params: { key: "setting" } },
    { protocol: 1, type: "event", event: "dispose", value: null },
  ])("fails closed on invalid/directionally wrong messages or host disposal", async (message) => {
    const { port, client } = fixture()
    const pending = client.storage.get("setting")
    const disposed = expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    port.receive(message); await disposed
    expect(port.closed).toBe(true)
  })
  it("handles message errors and closed transport without hanging", async () => {
    const { port, client } = fixture()
    port.closed = true
    await expect(client.storage.get("setting")).rejects.toMatchObject({ code: "DISPOSED" })
    port.dispatchEvent(new Event("messageerror"))
    expect(() => client.onContextChange(() => {})).toThrow()
  })
})
