import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DelegatedTaskCounts } from "../../../shared/contracts/orchestration"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), counts: null as DelegatedTaskCounts | null }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
import { DelegatedSessions } from "../DelegatedSessions"

beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(async () => Response.json({ counts: mocks.counts }))
})

describe("DelegatedSessions", () => {
  it("sums up the sessions this one started and opens the Crew panel", async () => {
    mocks.counts = { total: 3, running: 1, unread: 2, unreadRunning: 1 }
    const onOpenCrew = vi.fn()
    render(<DelegatedSessions sessionId="parent" onOpenCrew={onOpenCrew} />)

    const line = await screen.findByRole("status", { name: "Sessions this one started" })
    expect(line).toHaveTextContent("Crew · 1 running · 1 finished")
    await userEvent.click(screen.getByRole("button", { name: "Open crew" }))
    expect(onOpenCrew).toHaveBeenCalledOnce()
  })

  it("says nothing while the Crew panel is open", async () => {
    mocks.counts = { total: 1, running: 1, unread: 1, unreadRunning: 1 }
    const { container } = render(<DelegatedSessions sessionId="parent" crewOpen onOpenCrew={vi.fn()} />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("says nothing once every result is read or cancelled", async () => {
    mocks.counts = { total: 2, running: 0, unread: 0, unreadRunning: 0 }
    const { container } = render(<DelegatedSessions sessionId="parent" />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
