import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionBoard } from "../../../../shared/contracts/board"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), board: null as SessionBoard | null }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
vi.mock("@/hooks/useSessionNamer", () => ({ useSessionNamer: () => (id: string) => (id === "lead" ? "Wave 3 coordinator" : undefined) }))

import { BoardLine } from "../BoardLine"

beforeEach(() => {
  localStorage.clear()
  mocks.fetch.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({ board: mocks.board }) }))
})
afterEach(cleanup)

describe("BoardLine", () => {
  it("says where the work stands in a line and opens to its sections", async () => {
    mocks.board = {
      sessionId: "lead",
      title: "Wave 3",
      progress: { done: 35, total: 99 },
      sections: [
        { title: "Now", items: ["storefront PR shipping", "inventory rebasing"] },
        { title: "Needs you", tone: "warning", items: ["sentry-cli login"] },
        { title: "Later", items: [] },
      ],
      updatedAt: Date.now() - 120_000,
    }
    render(<BoardLine boardSessionId="lead" />)

    const line = await screen.findByRole("button", { expanded: false })
    expect(mocks.fetch).toHaveBeenCalledWith("/api/session-board/lead")
    expect(line).toHaveTextContent("Wave 3")
    expect(line).toHaveTextContent("35 of 99")
    expect(line).toHaveTextContent("Now 2")
    expect(line).toHaveTextContent("Needs you 1")
    expect(line).not.toHaveTextContent("Later")
    expect(line).toHaveTextContent("updated 2m by Wave 3 coordinator")

    fireEvent.click(line)
    expect(screen.getByText("sentry-cli login")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Needs you" })).toHaveClass("text-warning")
  })

  it("renders nothing while the session keeps no board", async () => {
    mocks.board = null
    const { container } = render(<BoardLine boardSessionId="solo" />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
