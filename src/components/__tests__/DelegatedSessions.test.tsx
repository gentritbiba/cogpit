import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DelegatedTask } from "../../../shared/contracts/orchestration"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), tasks: [] as DelegatedTask[] }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
import { DelegatedSessions } from "../DelegatedSessions"

function task(patch: Partial<DelegatedTask>): DelegatedTask {
  return { id: "t1", parentSessionId: "parent", childSessionId: "child-1", sourceId: "source", state: "running", createdAt: 0, updatedAt: 0, ...patch }
}

beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({ tasks: mocks.tasks }) }))
})

describe("DelegatedSessions", () => {
  it("sums up the sessions this one started and opens the Crew panel", async () => {
    mocks.tasks = [task({}), task({ id: "t2", state: "completed" }), task({ id: "t3", state: "completed", acknowledgedAt: 1 })]
    const onOpenCrew = vi.fn()
    render(<DelegatedSessions sessionId="parent" onOpenCrew={onOpenCrew} />)

    const line = await screen.findByRole("status", { name: "Sessions this one started" })
    expect(line).toHaveTextContent("Crew · 1 running · 1 finished")
    await userEvent.click(screen.getByRole("button", { name: "Open crew" }))
    expect(onOpenCrew).toHaveBeenCalledOnce()
  })

  it("says nothing while the Crew panel is open", async () => {
    mocks.tasks = [task({})]
    const { container } = render(<DelegatedSessions sessionId="parent" crewOpen onOpenCrew={vi.fn()} />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("says nothing once every result is read or cancelled", async () => {
    mocks.tasks = [task({ acknowledgedAt: 1, state: "completed" }), task({ id: "t2", state: "cancelled" })]
    const { container } = render(<DelegatedSessions sessionId="parent" />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
