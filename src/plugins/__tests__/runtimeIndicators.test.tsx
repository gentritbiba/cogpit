import { StrictMode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginRequest } from "@cogpit/plugin-contracts"
import { RuntimePluginIndicator, type RuntimeIndicatorClient, type RuntimePluginIndicatorProps } from "../runtimeIndicators"

const now = new Date(2026, 8, 15, 12).getTime()
let runs: unknown[], pulls: unknown[], deployments: unknown[]
let serial = 0
function makeClient() {
  const lease = vi.fn(async (_pluginId: string, _projectId: string | null, _epoch: string, _signal: AbortSignal, _workspacePath?: string | null) => ({ id: `lease-${++serial}`, expiresAt: Date.now() + 60_000 }))
  const call = vi.fn(async (_id: string, request: PluginRequest, _signal: AbortSignal): Promise<unknown> => {
    if (request.method === "integrations.request") {
      const data = request.params.operation === "actions" ? { runs } : request.params.operation === "pulls" ? { pulls } : { deployments }
      return { ok: true, data }
    }
    if (request.method === "connections.status") return { configured: true, readOnly: false, selected: { workspace: { id: "workspace", label: "Workspace" } } }
    return { tasks: [], last_page: true }
  })
  return { lease, call, revokeLease: vi.fn(async (_id: string) => {}) }
}
let client: ReturnType<typeof makeClient>
function props(overrides: Partial<RuntimePluginIndicatorProps> = {}): RuntimePluginIndicatorProps {
  return { client: client as unknown as RuntimeIndicatorClient, pluginId: "cogpit.vercel", projectId: "project-a", workspacePath: "/repo/worktree", activation: "host-user-a", registryRevision: 1, ...overrides }
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
function task(id: string, due = now - 86_400_000, type = "open") { return { id, name: id, status: { status: "Status", type }, list: { id: "list" }, due_date: String(due) } }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  runs = []; pulls = []; deployments = []; serial = 0; client = makeClient()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("trusted runtime sidebar indicator parity", () => {
  it.each([
    ["BUILDING", "1 active Vercel deployment", "1"], ["INITIALIZING", "1 active Vercel deployment", "1"],
    ["QUEUED", "1 active Vercel deployment", "1"], ["BLOCKED", "Latest Vercel deployment failed", "!"],
    ["CANCELED", "Latest Vercel deployment failed", "!"], ["ERROR", "Latest Vercel deployment failed", "!"],
  ])("preserves Vercel %s status", async (state, label, text) => {
    deployments = [{ state }]
    render(<RuntimePluginIndicator {...props()} />); await settle()
    expect(screen.getByLabelText(label)).toHaveTextContent(text)
    expect(client.call).toHaveBeenCalledWith("lease-1", expect.objectContaining({ method: "integrations.request", params: { integration: "vercel", operation: "deployments", limit: 20 } }), expect.any(AbortSignal))
  })
  it("prioritizes active deployments over the latest failure, and hides successful-only results", async () => {
    deployments = [{ state: "ERROR" }, { state: "BUILDING" }, { state: "QUEUED" }]
    render(<RuntimePluginIndicator {...props()} />); await settle()
    expect(screen.getByLabelText("2 active Vercel deployments")).toHaveTextContent("2")
    deployments = [{ state: "READY" }]
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.queryByText("2")).not.toBeInTheDocument()
  })
  it("preserves GitHub priority: active runs, latest failure, then open/draft requested reviews", async () => {
    runs = [{ status: "completed", conclusion: "failure" }, { status: "queued" }]
    pulls = [{ state: "open", reviewRequested: true }, { state: "draft", reviewRequested: true }, { state: "closed", reviewRequested: true }]
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.github" })} />); await settle()
    expect(screen.getByLabelText("1 active GitHub Actions run")).toHaveTextContent("1")
    runs = [{ status: "completed", conclusion: "failure" }]
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByLabelText("Latest GitHub Actions run failed")).toHaveTextContent("!")
    runs = [{ status: "completed", conclusion: "cancelled" }]
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByLabelText("2 pull requests waiting for your review")).toHaveTextContent("2")
    expect(client.call.mock.calls.filter(([, request]) => request.method === "integrations.request" && request.params.operation === "pulls")).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.call.mock.calls.filter(([, request]) => request.method === "integrations.request" && request.params.operation === "pulls")).toHaveLength(2)
  })
  it.each(["action_required", "startup_failure", "timed_out"])("treats GitHub %s as failed", async conclusion => {
    runs = [{ status: "completed", conclusion }]
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.github" })} />); await settle()
    expect(screen.getByLabelText("Latest GitHub Actions run failed")).toBeInTheDocument()
  })
  it.each([
    [{ status: "queued" }, "1 active GitHub Actions run"],
    [{ status: "completed", conclusion: "failure" }, "Latest GitHub Actions run failed"],
  ])("preserves the Actions badge if requested reviews fail: %j", async (run, label) => {
    runs = [run]
    const original = client.call.getMockImplementation()!
    client.call.mockImplementation((id, request, signal) => request.method === "integrations.request" && request.params.operation === "pulls"
      ? Promise.resolve({ ok: false, error: { code: "github_api_failed", message: "Unavailable" } }) : original(id, request, signal))
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.github" })} />); await settle()
    expect(screen.getByLabelText(label)).toBeInTheDocument()
    expect(client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
  })
  it("shows requested reviews when Actions fails but hides all results on a broker authorization failure", async () => {
    pulls = [{ state: "open", reviewRequested: true }]
    const original = client.call.getMockImplementation()!
    client.call.mockImplementation((id, request, signal) => request.method === "integrations.request" && request.params.operation === "actions"
      ? Promise.resolve({ ok: false, error: { code: "github_api_failed", message: "Unavailable" } }) : original(id, request, signal))
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.github" })} />); await settle()
    expect(screen.getByLabelText("1 pull request waiting for your review")).toBeInTheDocument()
    client.call.mockRejectedValue(new Error("Permission revoked"))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.queryByLabelText("1 pull request waiting for your review")).not.toBeInTheDocument()
  })
  it("fetches requested reviews even when the first clock reading is zero", async () => {
    vi.setSystemTime(0)
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.github" })} />); await settle()
    expect(client.call.mock.calls.some(([, request]) => request.method === "integrations.request" && request.params.operation === "pulls")).toBe(true)
  })
  it("counts ClickUp overdue days, preserves done as live, deduplicates pages and caps requests at three", async () => {
    const original = client.call.getMockImplementation()!
    client.call.mockImplementation(async (id, request, signal) => request.method === "connections.request"
      ? { tasks: [task("duplicate"), task(String(request.params.args.page), now - 86_400_000, "done"), task("closed", now - 86_400_000, "closed"), task("today", now - 1000)], last_page: false }
      : original(id, request, signal))
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.clickup", projectId: null, workspacePath: null })} />); await settle()
    expect(screen.getByLabelText("4 overdue ClickUp tasks")).toHaveTextContent("4")
    const requests = client.call.mock.calls.map(([, request]) => request)
    expect(requests).toHaveLength(4)
    expect(requests.slice(1).map(request => request.params)).toEqual([0, 1, 2].map(page => ({ handle: "clickup", operationId: "mine", args: { page } })))
    expect(client.lease.mock.calls[0]?.[4]).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(client.lease).toHaveBeenCalledOnce()
  })
  it("stops ClickUp pagination at the last page and does not read unconfigured connections", async () => {
    render(<RuntimePluginIndicator {...props({ pluginId: "cogpit.clickup" })} />); await settle()
    expect(client.call).toHaveBeenCalledTimes(2)
    client.call.mockResolvedValue({ configured: false, readOnly: false, selected: {} })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(client.call).toHaveBeenCalledTimes(3)
  })
})

describe("runtime indicator lease and scope lifetime", () => {
  it("uses only the existing manager boundary, exact workspace and a short lease", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    render(<RuntimePluginIndicator {...props()} />); await settle()
    expect(client.lease).toHaveBeenCalledWith("cogpit.vercel", "project-a", expect.stringMatching(/^[0-9a-f]{32}$/), expect.any(AbortSignal), "/repo/worktree")
    expect(client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
    expect(fetch).not.toHaveBeenCalled()
    expect(document.querySelectorAll("iframe")).toHaveLength(0)
  })
  it.each([
    { enabled: false }, { activation: "" }, { pluginId: "other.plugin" }, { projectId: null }, { workspacePath: null },
  ])("makes no requests when inactive or out of scope: %j", async overrides => {
    render(<RuntimePluginIndicator {...props(overrides)} />); await settle()
    expect(client.lease).not.toHaveBeenCalled()
  })
  it("ignores old responses and aborts the old lease on host/project/workspace/revision changes", async () => {
    let resolve!: (value: unknown) => void
    client.call.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const view = render(<RuntimePluginIndicator {...props()} />); await settle()
    const oldSignal = client.call.mock.calls[0]![2]
    deployments = [{ state: "READY" }]
    view.rerender(<RuntimePluginIndicator {...props({ projectId: "project-b", workspacePath: "/other/worktree", activation: "host-user-b", registryRevision: 2 })} />); await settle()
    expect(oldSignal.aborted).toBe(true)
    expect(client.revokeLease).toHaveBeenCalledWith("lease-1")
    expect(client.lease.mock.calls[1]?.[4]).toBe("/other/worktree")
    await act(async () => { resolve({ ok: true, data: { deployments: [{ state: "BUILDING" }] } }); await Promise.resolve() })
    expect(screen.queryByLabelText("1 active Vercel deployment")).not.toBeInTheDocument()
    expect(client.revokeLease.mock.calls.filter(([id]) => id === "lease-1")).toHaveLength(1)
  })
  it("revokes a lease minted after StrictMode cleanup without using it", async () => {
    let resolve!: (value: { id: string; expiresAt: number }) => void
    client.lease.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    render(<StrictMode><RuntimePluginIndicator {...props()} /></StrictMode>); await settle()
    expect(client.lease).toHaveBeenCalledTimes(2)
    await act(async () => { resolve({ id: "late-lease", expiresAt: now + 60_000 }); await Promise.resolve() })
    expect(client.revokeLease).toHaveBeenCalledWith("late-lease")
    expect(client.call.mock.calls.some(([id]) => id === "late-lease")).toBe(false)
  })
  it("does not overlap slow polls and cancels/revokes at the twenty-second deadline", async () => {
    client.call.mockImplementationOnce(() => new Promise(() => {}))
    const view = render(<RuntimePluginIndicator {...props()} />); await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.lease).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.call.mock.calls[0]![2].aborted).toBe(true)
    expect(client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(client.lease).toHaveBeenCalledOnce()
  })
  it("never calls an expired lease and clears badges on a failed next poll", async () => {
    deployments = [{ state: "BUILDING" }]
    render(<RuntimePluginIndicator {...props()} />); await settle()
    expect(screen.getByLabelText("1 active Vercel deployment")).toBeInTheDocument()
    client.lease.mockResolvedValue({ id: "expired", expiresAt: now })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(client.call).toHaveBeenCalledOnce()
    expect(client.revokeLease).toHaveBeenCalledWith("expired")
    expect(screen.queryByLabelText("1 active Vercel deployment")).not.toBeInTheDocument()
  })
  it("skips hidden documents and resumes immediately on visibility", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    render(<RuntimePluginIndicator {...props()} />); await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(client.lease).not.toHaveBeenCalled()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    act(() => { document.dispatchEvent(new Event("visibilitychange")) }); await settle()
    expect(client.lease).toHaveBeenCalledOnce()
  })
  it("aborts and releases a pending request on unmount", async () => {
    client.call.mockImplementationOnce(() => new Promise(() => {}))
    const view = render(<RuntimePluginIndicator {...props()} />); await settle()
    view.unmount()
    expect(client.call.mock.calls[0]![2].aborted).toBe(true)
    expect(client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
  })
})
