import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { PowerMonitor } from "@/components/PowerMonitor"
import type {
  ElectronPerformanceSnapshot,
  ServerPerformanceSnapshot,
} from "../../../shared/contracts/performance"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  getElectronSnapshot: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

const electronSnapshot: ElectronPerformanceSnapshot = {
  capturedAt: 1,
  processes: [
    { pid: 10, name: "Renderer", type: "Tab", cpuPercent: 42, memoryMb: 180 },
    { pid: 11, name: "Server", type: "Utility", cpuPercent: 8, memoryMb: 95 },
  ],
}

const serverSnapshot: ServerPerformanceSnapshot = {
  capturedAt: 1,
  sampleWindowSeconds: 10,
  cpuPercent: 8,
  eventLoopPercent: 12,
  uptimeSeconds: 100,
  memory: { rssMb: 95, heapUsedMb: 40 },
  activities: [{
    name: "Session file checks",
    count: 20,
    totalCount: 200,
    ratePerSecond: 2,
    bytesPerSecond: 0,
    active: 1,
  }],
  requests: [{
    name: "GET /api/permissions",
    count: 16,
    totalCount: 500,
    ratePerSecond: 1.6,
    bytesPerSecond: 0,
    averageDurationMs: 3,
  }],
}

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  } as unknown as Response
}

describe("PowerMonitor", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
    mocks.getElectronSnapshot.mockReset()
    mocks.authFetch.mockResolvedValue(response(serverSnapshot))
    mocks.getElectronSnapshot.mockResolvedValue(electronSnapshot)
    Object.defineProperty(window, "electronPerformance", {
      configurable: true,
      value: { getSnapshot: mocks.getElectronSnapshot },
    })
  })

  it("does not sample until opened, then identifies the busiest process and activity", async () => {
    const view = render(<PowerMonitor open={false} onOpenChange={vi.fn()} />)

    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(mocks.getElectronSnapshot).not.toHaveBeenCalled()

    view.rerender(<PowerMonitor open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole("heading", { name: "Power & activity monitor" })).toBeInTheDocument()
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/performance"))
    expect(await screen.findByText("The renderer is doing the most work, which points to repeated UI rendering, layout, or animation."))
      .toBeInTheDocument()
    expect(screen.getByText("Session file checks")).toBeInTheDocument()
    expect(screen.getByText("GET /api/permissions")).toBeInTheDocument()
    expect(screen.getByText("50% CPU")).toBeInTheDocument()

    view.unmount()
  })

  it("shows proven old session ownership and sends a single identity-bound manual stop", async () => {
    const metric = {
      pid: 53013, kind: "script", label: "Python", command: "Python -", cpuPercent: 98, memoryMb: 40,
      ageSeconds: 15 * 86400, orphaned: true, suspectedLeak: true, warning: "sustained-cpu", canStop: true, identity: "a".repeat(64),
      owner: { sessionId: "58479731-3c68-489f-8327-bbad21533d66", taskId: "bt3fj0wjf", title: "HonestCMS code bloat cleanup", dirName: "-project", fileName: "58479731-3c68-489f-8327-bbad21533d66.jsonl" },
    }
    mocks.authFetch.mockImplementation(async (url: string) => response(url.endsWith("/kill") ? { killed: [53013] } : {
      ...serverSnapshot, system: { capturedAt: 1, suspectedLeakCount: 2, processes: [metric, { ...metric, pid: 53014, owner: undefined, canStop: false }] },
    }))
    render(<PowerMonitor open onOpenChange={vi.fn()} />)
    const link = await screen.findByRole("link", { name: "HonestCMS code bloat cleanup" })
    expect(link.getAttribute("href")).toContain("58479731-3c68-489f-8327-bbad21533d66")
    expect(screen.getAllByText(/task bt3fj0wjf/)).toHaveLength(1)
    expect(screen.getByText("Session ownership unknown")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop process 53014" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop process 53013" }))
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/system-processes/kill", expect.objectContaining({
      method: "POST", body: JSON.stringify({ processes: [{ pid: 53013, identity: "a".repeat(64) }] }),
    })))
  })
})
