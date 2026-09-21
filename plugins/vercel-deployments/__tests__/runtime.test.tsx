import { act, cleanup, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginContext } from "@cogpit/plugin-sdk"
const mocks = vi.hoisted(() => ({ createPluginClient: vi.fn() }))
vi.mock("@cogpit/plugin-sdk", () => mocks)
import { mountVercel } from "../runtime"

const initial: PluginContext = { project: { id: "project-a", name: "Project A" }, theme: { mode: "light", tokens: {} }, locale: "en", reducedMotion: false, visible: true }
const data = { projectId: "prj_a", projectName: "Project A", projectUrl: null, teamId: "team_a", deployments: [] }
let dispose: (() => void) | undefined
let sdk: ReturnType<typeof makeSdk>
function makeSdk() {
  const listeners: { context?: (value: PluginContext) => void; visibility?: (value: boolean) => void } = {}
  return {
    listeners,
    ready: vi.fn(async () => null), dispose: vi.fn(),
    integrations: { request: vi.fn(async (_input: unknown, _options: { signal: AbortSignal }) => ({ ok: true as const, data })) },
    navigation: { openExternal: vi.fn(async () => null) },
    onContextChange: vi.fn((listener: (value: PluginContext) => void) => { listeners.context = listener; return vi.fn() }),
    onVisibilityChange: vi.fn((listener: (value: boolean) => void) => { listeners.visibility = listener; return vi.fn() }),
  }
}
beforeEach(() => { sdk = makeSdk(); mocks.createPluginClient.mockReturnValue(sdk) })
afterEach(() => { act(() => dispose?.()); dispose = undefined; cleanup(); vi.restoreAllMocks() })
function mount(context = initial) { act(() => { dispose = mountVercel({ context, port: {} as MessagePort, assets: {} }) }) }

describe("Vercel package runtime entry", () => {
  it("runs the existing panel over the SDK without legacy HTTP calls or private workspace paths", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    mount()
    expect(await screen.findByText("No deployments yet")).toBeInTheDocument()
    expect(sdk.integrations.request).toHaveBeenCalledWith({ integration: "vercel", operation: "deployments", limit: 20 }, { signal: expect.any(AbortSignal) })
    expect(sdk.ready).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Close Vercel deployments" })).not.toBeInTheDocument()
  })
  it("does not request data until its existing panel becomes visible", async () => {
    mount({ ...initial, visible: false })
    expect(sdk.integrations.request).not.toHaveBeenCalled()
    act(() => sdk.listeners.visibility?.(true))
    await screen.findByText("No deployments yet")
    expect(sdk.integrations.request).toHaveBeenCalledOnce()
  })
  it("aborts the old scope and ignores its late response after a context switch", async () => {
    let resolve!: (value: { ok: true; data: typeof data }) => void
    sdk.integrations.request.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    mount()
    await waitFor(() => expect(sdk.integrations.request).toHaveBeenCalledOnce())
    const oldSignal = sdk.integrations.request.mock.calls[0]![1].signal
    sdk.integrations.request.mockResolvedValue({ ok: true, data: { ...data, projectName: "Project B" } })
    act(() => sdk.listeners.context?.({ ...initial, project: { id: "project-b", name: "Project B" } }))
    await screen.findByText("No deployments yet")
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { resolve({ ok: true, data: { ...data, deployments: [] } }); await Promise.resolve() })
    expect(sdk.integrations.request).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll("#root")).toHaveLength(1)
  })
  it("stops SDK requests and presentation listeners on disposal", async () => {
    mount(); await screen.findByText("No deployments yet")
    const signal = sdk.integrations.request.mock.calls[0]![1].signal
    act(() => { dispose!(); dispose!() })
    expect(signal.aborted).toBe(true)
    expect(sdk.dispose).toHaveBeenCalledOnce()
    expect(document.querySelector("#root")).toBeNull()
    for (const method of [sdk.onContextChange, sdk.onVisibilityChange]) expect(method.mock.results[0]!.value).toHaveBeenCalledOnce()
  })
})
