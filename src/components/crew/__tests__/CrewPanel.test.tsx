import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewMember, SessionCrew } from "../../../../shared/contracts/crew"
import type { WorkspacePanelContext } from "@/plugin-api"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), json: vi.fn(), crew: null as unknown as SessionCrew, navigate: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch, jsonFetch: mocks.json }))
vi.mock("@/lib/revealSession", async (original) => ({
  ...await original<typeof import("@/lib/revealSession")>(),
  revealSessionById: vi.fn(), revealSessionPath: mocks.navigate,
}))

import { CrewPanel } from "../CrewPanel"

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function member(sessionId: string, overrides: Partial<CrewMember> = {}): CrewMember {
  return {
    sessionId, parentId: "coordinator", startedAt: 1, device: null,
    address: { dirName: `-${sessionId}`, fileName: `${sessionId}.jsonl` },
    outcome: "completed", waiting: [], cwd: `/work/${sessionId}`, lastActivityAt: minutesAgo(30), ...overrides,
  }
}

const crew: SessionCrew = {
  sessionId: "lane",
  rootId: "coordinator",
  members: [
    member("coordinator", { parentId: null, startedAt: null, customTitle: "Wave 3 coordinator", cwd: "/work/ops" }),
    member("lane", { startedAt: 10, outcome: "running", status: "tool_use", toolName: "Bash", pullRequests: [{ url: "", number: 244, repo: "o/r", title: null, isDraft: false, toolCallId: "", timestamp: "" }] }),
    member("rooftop", {
      startedAt: 20, outcome: "needs_input", lastActivityAt: minutesAgo(42),
      waiting: [{ kind: "permission", askedAt: Date.now() - 42 * 60_000, requestId: "perm-1", toolName: "Bash", summary: "gh api rulesets", availableDecisions: ["allow", "deny"] }],
    }),
    member("theories", { startedAt: 30, result: { taskId: "task-9", state: "completed", acknowledged: false } }),
  ],
}

function renderPanel() {
  const openSession = vi.fn()
  const context = { session: { sessionId: "lane" }, openSession } as unknown as WorkspacePanelContext
  render(<CrewPanel context={context} active closePanel={vi.fn()} />)
  return { openSession }
}

beforeEach(() => {
  mocks.crew = crew
  mocks.navigate.mockReset()
  mocks.fetch.mockReset().mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.startsWith("/api/crew-chat/") ? { rootId: mocks.crew.rootId, messages: [], members: [], canPost: true, hasMore: false, nextCursor: 0 } : mocks.crew }))
  mocks.json.mockReset().mockResolvedValue({ ok: true, status: 200 })
})
afterEach(cleanup)

describe("CrewPanel", () => {
  it("opens a remote member on its owning device", async () => {
    mocks.crew = { ...crew, members: [crew.members[0]!, member("remote", { device: { id: "dev_1", name: "agentbox" } })] }
    const { openSession } = renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "remote, Finished" }))
    expect(mocks.navigate).toHaveBeenCalledWith("/d/dev_1/-remote/remote")
    expect(openSession).not.toHaveBeenCalled()
  })
  it("rolls the crew up under its root: one cell per member, and counts", async () => {
    renderPanel()
    expect(await screen.findByRole("button", { name: "Wave 3 coordinator" })).toBeInTheDocument()
    expect(mocks.fetch).toHaveBeenCalledWith("/api/session-crew/lane")

    const cells = [...document.querySelectorAll("[data-crew-cell]")].map((cell) => cell.getAttribute("data-crew-cell"))
    expect(cells).toEqual(["working", "needs-you", "done"])
    const summary = screen.getByRole("region", { name: "Crew summary" })
    expect(summary).toHaveTextContent("3 sessions")
    expect(summary).toHaveTextContent("1 working")
    expect(summary).toHaveTextContent("1 needs you")
    expect(summary).toHaveTextContent("1 result unread")
  })

  it("answers what a member waits on in place", async () => {
    renderPanel()
    const queue = await screen.findByRole("region", { name: "Needs you" })
    expect(queue).toHaveTextContent("rooftop")
    expect(queue).toHaveTextContent("waiting 42m")

    fireEvent.click(within(queue).getByRole("button", { name: "Allow" }))
    await waitFor(() => expect(mocks.json).toHaveBeenCalledWith("/api/session-respond", { sessionId: "rooftop", requestId: "perm-1", decision: "allow" }))
  })

  it("lists every member, marks where the user is, and opens one", async () => {
    const { openSession } = renderPanel()
    const sessions = await screen.findByRole("region", { name: "Sessions" })
    const lane = within(sessions).getByRole("button", { name: "lane, Bash" })
    expect(lane).toHaveAttribute("aria-current", "true")
    expect(lane).toHaveTextContent("you are here")
    expect(lane).toHaveTextContent("#244")

    fireEvent.click(within(sessions).getByRole("button", { name: "theories, Finished · result unread" }))
    expect(openSession).toHaveBeenCalledWith("-theories", "theories.jsonl")
  })

  it("marks a result read and stops a working member", async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Mark theories's result read" }))
    await waitFor(() => expect(mocks.json).toHaveBeenCalledWith("/api/delegated-tasks", { sessionId: "coordinator", taskId: "task-9", action: "ack" }))

    fireEvent.click(screen.getByRole("button", { name: "Stop lane" }))
    await waitFor(() => expect(mocks.json).toHaveBeenCalledWith("/api/stop-session", { sessionId: "lane", cancelQueued: true }))
  })

  it("maps the crew from its root next to the overview, and opens a member from the map", async () => {
    const { openSession } = renderPanel()
    fireEvent.click(await screen.findByRole("tab", { name: "Map" }))
    const map = await screen.findByRole("region", { name: "Crew map" })
    const cards = [...map.querySelectorAll("[data-crew-map-card]")]
    expect(cards.map((card) => card.getAttribute("data-crew-map-card"))).toEqual(["coordinator", "lane", "rooftop", "theories"])
    expect(within(map).getByRole("button", { name: "lane, Bash" })).toHaveAttribute("aria-current", "true")

    fireEvent.click(within(map).getByRole("button", { name: "theories, Finished · result unread" }))
    expect(openSession).toHaveBeenCalledWith("-theories", "theories.jsonl")
  })

  it("filters the list by what members are doing", async () => {
    renderPanel()
    const sessions = await screen.findByRole("region", { name: "Sessions" })
    fireEvent.click(within(sessions).getByRole("radio", { name: "Need you" }))
    expect(within(sessions).getAllByRole("listitem").map((item) => item.getAttribute("data-crew-row"))).toEqual(["rooftop"])
  })

  function nestedCrew() {
    mocks.crew = {
      ...crew,
      members: [
        ...crew.members,
        member("branch", { parentId: "lane", startedAt: 40 }),
        member("helper", { parentId: "branch", startedAt: 50, outcome: "needs_input" }),
      ],
    }
  }

  it("folds every descendant without opening the parent, preserving nested folds and siblings", async () => {
    nestedCrew()
    const { openSession } = renderPanel()
    const sessions = await screen.findByRole("region", { name: "Sessions" })
    expect(within(sessions).queryByRole("button", { name: /Collapse theories/ })).not.toBeInTheDocument()
    fireEvent.click(within(sessions).getByRole("button", { name: "Collapse branch's child sessions" }))
    fireEvent.click(within(sessions).getByRole("button", { name: "Collapse lane's child sessions" }))
    expect(openSession).not.toHaveBeenCalled()
    expect(within(sessions).queryByRole("button", { name: "branch, Finished" })).not.toBeInTheDocument()
    expect(within(sessions).queryByRole("button", { name: "helper, Plan to review" })).not.toBeInTheDocument()
    expect(within(sessions).getByRole("button", { name: "theories, Finished · result unread" })).toBeInTheDocument()
    expect(within(sessions).getByRole("button", { name: "Expand lane's child sessions" })).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(within(sessions).getByRole("button", { name: "Expand lane's child sessions" }))
    expect(within(sessions).getByRole("button", { name: "branch, Finished" })).toBeInTheDocument()
    expect(within(sessions).queryByRole("button", { name: "helper, Plan to review" })).not.toBeInTheDocument()
    fireEvent.click(within(sessions).getByRole("button", { name: "Expand branch's child sessions" }))
    fireEvent.click(within(sessions).getByRole("button", { name: "helper, Plan to review" }))
    expect(openSession).toHaveBeenCalledWith("-helper", "helper.jsonl")
  })

  it("reveals matching descendants in status filters and restores folds on All", async () => {
    nestedCrew()
    renderPanel()
    const sessions = await screen.findByRole("region", { name: "Sessions" })
    fireEvent.click(within(sessions).getByRole("button", { name: "Collapse lane's child sessions" }))
    fireEvent.click(within(sessions).getByRole("radio", { name: "Need you" }))
    expect(within(sessions).getByRole("button", { name: "helper, Plan to review" })).toBeInTheDocument()
    fireEvent.click(within(sessions).getByRole("radio", { name: "All" }))
    expect(within(sessions).queryByRole("button", { name: "helper, Plan to review" })).not.toBeInTheDocument()
  })

  it("supports keyboard folding", async () => {
    nestedCrew()
    const user = userEvent.setup()
    renderPanel()
    const toggle = await screen.findByRole("button", { name: "Collapse lane's child sessions" })
    toggle.focus()
    await user.keyboard("{Enter}")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.keyboard(" ")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
  })

  it("unfolds ancestors when a hidden member is selected from the summary strip", async () => {
    nestedCrew()
    const scroll = vi.fn()
    const previous = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      renderPanel()
      const sessions = await screen.findByRole("region", { name: "Sessions" })
      fireEvent.click(within(sessions).getByRole("button", { name: "Collapse branch's child sessions" }))
      fireEvent.click(within(sessions).getByRole("button", { name: "Collapse lane's child sessions" }))
      fireEvent.click(screen.getByRole("listitem", { name: "helper: Plan to review" }))
      expect(within(sessions).getByRole("button", { name: "helper, Plan to review" })).toBeInTheDocument()
      await waitFor(() => expect(scroll).toHaveBeenCalled())
    } finally {
      Element.prototype.scrollIntoView = previous
    }
  })
})
