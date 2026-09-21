import { act, cleanup, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { JsonValue } from "@cogpit/plugin-sdk"
const sdk = vi.hoisted(() => ({ createPluginClient: vi.fn() }))
vi.mock("@cogpit/plugin-sdk", () => sdk)
import { mountClickUp } from "../runtime"
import { connectionStatus, deferred, fakeClient, rawTask, runtimeContext, viewer } from "./runtimeFixtures"
const cleanups: (() => void)[] = []
afterEach(() => { act(() => { for (const stop of cleanups.splice(0)) stop() }); cleanup(); document.documentElement.removeAttribute("style"); document.documentElement.className = ""; vi.clearAllMocks() })
function mount(client = fakeClient()) {
  sdk.createPluginClient.mockReturnValue(client)
  let stop!: () => void
  act(() => { stop = mountClickUp({ port: {} as MessagePort, context: runtimeContext, assets: {} }) })
  cleanups.push(stop)
  return { client, stop }
}
describe("ClickUp frame entry lifetime", () => {
  it("binds the supplied port, renders its own React root, and follows visibility/context events", async () => {
    const { client, stop } = mount()
    await screen.findByRole("article", { name: "Task 1" })
    expect(client.ready).toHaveBeenCalledOnce()
    expect(client.onThemeChange).not.toHaveBeenCalled()
    act(() => vi.mocked(client.onVisibilityChange).mock.calls[0][0](false))
    act(() => vi.mocked(client.onContextChange).mock.calls[0][0]({ ...runtimeContext, reducedMotion: true }))
    act(stop)
    act(stop)
    expect(client.dispose).toHaveBeenCalledOnce()
    expect(document.getElementById("root")).toBeNull()
  })
  it("aborts old project requests and ignores their late payload after a project switch", async () => {
    const client = fakeClient(), old = deferred<JsonValue>()
    let first = true, oldSignal: AbortSignal | undefined
    vi.mocked(client.connections.request).mockImplementation(async (_h, op, _args, options): Promise<JsonValue> => {
      if (op === "viewer") return { user: viewer }
      if (first) { first = false; oldSignal = options?.signal; return old.promise }
      return { tasks: [rawTask("new")], last_page: true }
    })
    mount(client)
    await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve() })
    expect(oldSignal).toBeDefined()
    act(() => vi.mocked(client.onContextChange).mock.calls[0][0]({ ...runtimeContext, project: { id: "project.two", name: "Second" } }))
    await screen.findByRole("article", { name: "Task new" })
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { old.resolve({ tasks: [rawTask("old")], last_page: true }); await old.promise })
    expect(screen.queryByRole("article", { name: "Task old" })).not.toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Task new" })).toBeInTheDocument()
  })
  it("unsubscribes every SDK event and aborts pending calls when the frame closes", async () => {
    const client = fakeClient(), stopContext = vi.fn(), stopVisibility = vi.fn(), pending = deferred<typeof connectionStatus>()
    vi.mocked(client.onContextChange).mockReturnValue(stopContext)
    vi.mocked(client.onVisibilityChange).mockReturnValue(stopVisibility)
    vi.mocked(client.connections.status).mockReturnValue(pending.promise)
    mount(client)
    await act(async () => { await Promise.resolve() })
    const signal = vi.mocked(client.connections.status).mock.calls[0][1]!.signal!
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(signal.aborted).toBe(true)
    expect(client.dispose).toHaveBeenCalledOnce()
    for (const stop of [stopContext, stopVisibility]) expect(stop).toHaveBeenCalledOnce()
    await act(async () => { pending.reject(new Error("late error")); await pending.promise.catch(() => undefined) })
    expect(document.getElementById("root")).toBeNull()
  })
})
