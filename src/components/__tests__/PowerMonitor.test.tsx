import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PowerMonitor } from "@/components/PowerMonitor"
import type {
  ElectronPerformanceSnapshot,
  ServerPerformanceSnapshot,
} from "@/lib/performanceTypes"

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
    const user = userEvent.setup()
    const view = render(<PowerMonitor />)

    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(mocks.getElectronSnapshot).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Power & activity monitor" }))

    expect(await screen.findByRole("heading", { name: "Power & activity monitor" })).toBeInTheDocument()
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/performance"))
    expect(await screen.findByText("The renderer is doing the most work, which points to repeated UI rendering, layout, or animation."))
      .toBeInTheDocument()
    expect(screen.getByText("Session file checks")).toBeInTheDocument()
    expect(screen.getByText("GET /api/permissions")).toBeInTheDocument()
    expect(screen.getByText("50% CPU")).toBeInTheDocument()

    view.unmount()
  })
})
