import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ListedBoard } from "../../../../shared/contracts/board"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), board: null as ListedBoard | null }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
vi.mock("@/hooks/useSessionNamer", () => ({ useSessionNamer: () => (id: string) => (id === "lead" ? "Wave 3 coordinator" : undefined) }))

import { __resetSessionBoardsForTest } from "@/hooks/useSessionBoards"
import { BoardLine } from "../BoardLine"

beforeEach(() => {
  localStorage.clear()
  __resetSessionBoardsForTest()
  mocks.fetch.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({ boards: mocks.board ? [mocks.board] : [] }) }))
})
afterEach(cleanup)

describe("BoardLine", () => {
  it("says where the work stands in a line and opens to its sections", async () => {
    mocks.board = {
      sessionId: "lead",
      rootId: "lead",
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

    const expand = await screen.findByRole("button", { name: "Expand board" })
    expect(mocks.fetch).toHaveBeenCalledWith("/api/session-boards")
    const board = screen.getByRole("region", { name: "Board" })
    expect(board).toHaveTextContent("Wave 3")
    expect(board).toHaveTextContent("35/99")
    expect(board).toHaveTextContent("Updated 2m ago")
    expect(board).not.toHaveTextContent("Later")
    expect(screen.getByTitle("Kept by Wave 3 coordinator")).toBeInTheDocument()
    const sections = screen.getByRole("group", { name: "Board sections" })
    expect([...sections.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Needs you 1", "Now 2"])
    expect(screen.queryByText("sentry-cli login")).not.toBeInTheDocument()

    fireEvent.click(expand)
    expect(screen.getByRole("button", { name: "Needs you 1" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("region", { name: "Needs you" })).toHaveTextContent("sentry-cli login")

    fireEvent.click(screen.getByRole("button", { name: "Now 2" }))
    const now = screen.getByRole("region", { name: "Now" })
    expect(now).toHaveTextContent("storefront PR shipping")
    expect(now).not.toHaveTextContent("sentry-cli login")
    expect(JSON.parse(localStorage.getItem("board-line-open") ?? "{}")).toEqual({ lead: { index: 1, title: "Now" } })

    fireEvent.click(screen.getByRole("button", { name: "Now 2" }))
    expect(screen.queryByRole("region", { name: "Now" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Expand board" })).toHaveAttribute("aria-expanded", "false")
  })

  it("sets an item's subject in bold", async () => {
    mocks.board = {
      sessionId: "lead",
      rootId: "lead",
      sections: [{ title: "Needs you", tone: "warning", items: ["OpenRouter: add credits at https://openrouter.ai/settings"] }],
      updatedAt: Date.now(),
    }
    localStorage.setItem("board-line-open", JSON.stringify({ lead: { index: 0, title: "Needs you" } }))
    render(<BoardLine boardSessionId="lead" />)

    const subject = await screen.findByText("OpenRouter")
    expect(subject).toHaveClass("font-medium")
    expect(screen.getByRole("link", { name: "https://openrouter.ai/settings" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Board" })).toHaveTextContent("Updated just now")
  })

  it("opens each of two sections that share a title", async () => {
    mocks.board = {
      sessionId: "lead",
      rootId: "lead",
      sections: [{ title: "Now", items: ["first"] }, { title: "Now", items: ["second"] }],
      updatedAt: Date.now(),
    }
    render(<BoardLine boardSessionId="lead" />)

    const [, second] = await screen.findAllByRole("button", { name: "Now 1" })
    fireEvent.click(second)
    expect(second).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("region", { name: "Now" })).toHaveTextContent("second")
    expect(screen.getByRole("region", { name: "Now" })).not.toHaveTextContent("first")
  })

  it("dates a board older than a week instead of counting back", async () => {
    const updatedAt = Date.now() - 10 * 86_400_000
    mocks.board = { sessionId: "lead", rootId: "lead", sections: [{ title: "Now", items: ["x"] }], updatedAt }
    render(<BoardLine boardSessionId="lead" />)
    expect(await screen.findByText(`Updated on ${new Date(updatedAt).toLocaleDateString()}`)).toBeInTheDocument()
  })

  it("renders nothing while the session keeps no board", async () => {
    mocks.board = null
    const { container } = render(<BoardLine boardSessionId="solo" />)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
