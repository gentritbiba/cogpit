import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ListedBoard } from "../../../../shared/contracts/board"
import type { WorkspacePanelContext } from "@/plugin-api"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), boards: [] as ListedBoard[], reveal: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
vi.mock("@/lib/revealSession", () => ({ revealSessionById: mocks.reveal }))
vi.mock("@/hooks/useSessionNamer", () => ({
  useSessionNamer: () => (id: string) => ({ pm: "PM HonestCMS", storefront: "STOREFRONT lead" } as Record<string, string>)[id],
}))

import { __resetSessionBoardsForTest } from "@/hooks/useSessionBoards"
import { MemberStatusButton, SessionStatusLine, useStatusLinkBoard } from "../StatusLink"
import { StatusPanel } from "../StatusPanel"
import { StatusPanelProvider, useStatusPanel } from "../StatusPanelContext"

const board = (sessionId: string, rootId: string, overrides: Partial<ListedBoard> = {}): ListedBoard => ({
  sessionId, rootId, sections: [], updatedAt: Date.now() - 120_000, ...overrides,
})

const context = (sessionId: string | null, rootId?: string): WorkspacePanelContext => ({
  sessionId,
  sessionChangeKey: 0,
  projectPath: null,
  hasFileChanges: false,
  canAccessHostFiles: true,
  canUseBrowser: true,
  ...(rootId && { crew: { rootId, size: 2, needsYou: 0, working: 1 } }),
})

function CardStatus({ sessionId }: { sessionId: string }) {
  const board = useStatusLinkBoard(sessionId)
  return board && <SessionStatusLine board={board} />
}

function Opener({ id }: { id: string }) {
  const panel = useStatusPanel()
  return <button type="button" onClick={() => panel?.open(id)}>open {id}</button>
}

async function renderPanel(openId: string | null, rootId?: string, extra?: ReactNode) {
  const reveal = vi.fn()
  render(
    <StatusPanelProvider openSessionId={openId} onReveal={reveal}>
      {extra}
      <StatusPanel context={context(openId, rootId)} active closePanel={vi.fn()} />
    </StatusPanelProvider>,
  )
  await act(async () => {})
  return reveal
}

beforeEach(() => {
  __resetSessionBoardsForTest()
  mocks.boards = [
    board("storefront", "pm", { name: "ignored", title: "Nav fix", progress: { done: 6, total: 9 }, updatedAt: Date.now() - 60_000 }),
    board("pm", "pm", {
      title: "Release 52",
      progress: { done: 34, total: 41 },
      sections: [
        { title: "Landed", tone: "success", items: ["1c019e9 nav wrapper"] },
        { title: "Now", items: ["GL-180 in review, see https://github.com/x/y/pull/9"] },
        { title: "Needs you", tone: "warning", items: ["CF token for the router deploy", "Approve promotion #51"] },
        { title: "Later", items: [] },
      ],
    }),
    board("solo", "solo", { name: "Docs sweep", title: "Docs" }),
  ]
  mocks.fetch.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({ boards: mocks.boards }) }))
})
afterEach(cleanup)

describe("StatusPanel", () => {
  it("leads with the open session's status, what needs the user first, and folds the rest of its crew", async () => {
    await renderPanel("pm", "pm")
    const cards = screen.getAllByRole("article")
    expect(cards.map((card) => card.getAttribute("data-status-card"))).toEqual(["pm", "storefront"])

    const lead = within(cards[0]!)
    expect(lead.getByText("Release 52")).toBeInTheDocument()
    expect(lead.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34")
    expect(lead.getByText("34/41 · 7 left")).toBeInTheDocument()
    expect(lead.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Needs you · 2", "Now · 1", "Landed · 1"])
    expect(lead.getByRole("link", { name: "https://github.com/x/y/pull/9" })).toHaveAttribute("target", "_blank")
    fireEvent.click(lead.getByRole("button", { name: "Open the conversation of PM HonestCMS" }))
    expect(mocks.reveal).toHaveBeenCalledWith("pm")

    const member = within(cards[1]!)
    expect(member.getByText(/STOREFRONT lead/)).toBeInTheDocument()
    expect(member.getByText("6/9")).toBeInTheDocument()
    expect(member.queryByRole("heading")).toBeNull()
    fireEvent.click(member.getByRole("button", { expanded: false }))
    expect(member.getByRole("button", { expanded: true })).toBeInTheDocument()
  })

  it("shows every agent's status on request, naming sessions the list does not carry by the name they were started with", async () => {
    await renderPanel("pm", "pm")
    fireEvent.click(screen.getByRole("button", { name: /^All/ }))
    expect(screen.getAllByRole("article")).toHaveLength(3)
    expect(screen.getByText(/Docs sweep/)).toBeInTheDocument()
  })

  it("leads with the session a row asked for and reveals the panel", async () => {
    const reveal = await renderPanel("pm", "pm", <Opener id="storefront" />)
    fireEvent.click(screen.getByRole("button", { name: "open storefront" }))
    expect(reveal).toHaveBeenCalled()
    expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-status-card", "storefront")
  })

  it("drops a chosen status once another conversation opens, even while the panel is closed and after coming back", async () => {
    function Workspace() {
      const [openId, setOpenId] = useState("pm")
      const [shown, setShown] = useState(false)
      return (
        <StatusPanelProvider openSessionId={openId} onReveal={() => setShown(true)}>
          <Opener id="storefront" />
          <button type="button" onClick={() => setShown(false)}>close panel</button>
          <button type="button" onClick={() => setOpenId("solo")}>open solo</button>
          <button type="button" onClick={() => setOpenId("pm")}>open pm</button>
          <button type="button" onClick={() => setShown(true)}>show panel</button>
          {shown && <StatusPanel context={context(openId)} active closePanel={vi.fn()} />}
        </StatusPanelProvider>
      )
    }
    render(<Workspace />)
    fireEvent.click(screen.getByRole("button", { name: "open storefront" }))
    expect(await screen.findAllByRole("article")).not.toHaveLength(0)
    expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-status-card", "storefront")

    fireEvent.click(screen.getByRole("button", { name: "close panel" }))
    fireEvent.click(screen.getByRole("button", { name: "open solo" }))
    fireEvent.click(screen.getByRole("button", { name: "show panel" }))
    expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-status-card", "solo")

    fireEvent.click(screen.getByRole("button", { name: "close panel" }))
    fireEvent.click(screen.getByRole("button", { name: "open pm" }))
    fireEvent.click(screen.getByRole("button", { name: "show panel" }))
    expect(screen.getAllByRole("article")[0]).toHaveAttribute("data-status-card", "pm")
  })

  it("explains how agents publish a status when none is kept", async () => {
    mocks.boards = []
    await renderPanel("pm")
    expect(screen.getByText("No status yet")).toBeInTheDocument()
  })
})

describe("status links", () => {
  it("opens the panel on a session from its card and from its crew row", async () => {
    const reveal = vi.fn()
    render(
      <StatusPanelProvider openSessionId="pm" onReveal={reveal}>
        <CardStatus sessionId="pm" />
        <MemberStatusButton sessionId="storefront" name="STOREFRONT lead" />
        <CardStatus sessionId="nobody" />
      </StatusPanelProvider>,
    )
    const line = await screen.findByRole("button", { name: "Show status: Release 52" })
    expect(line).toHaveTextContent("34/41")
    expect(line).toHaveTextContent("2 need you")
    fireEvent.click(line)
    fireEvent.click(screen.getByRole("button", { name: "Show the status of STOREFRONT lead" }))
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole("button")).toHaveLength(2)
  })

  it("renders nothing where the layout has no status panel", async () => {
    const { container } = render(<><CardStatus sessionId="pm" /><MemberStatusButton sessionId="pm" name="PM" /></>)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })
})
