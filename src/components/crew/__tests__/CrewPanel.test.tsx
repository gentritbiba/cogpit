import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
  mocks.fetch.mockReset().mockImplementation(async () => ({ ok: true, status: 200, json: async () => mocks.crew }))
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
    await waitFor(() => expect(mocks.json).toHaveBeenCalledWith("/api/stop-session", { sessionId: "lane" }))
  })

  it("filters the list by what members are doing", async () => {
    renderPanel()
    const sessions = await screen.findByRole("region", { name: "Sessions" })
    fireEvent.click(within(sessions).getByRole("radio", { name: "Need you" }))
    expect(within(sessions).getAllByRole("listitem").map((item) => item.getAttribute("data-crew-row"))).toEqual(["rooftop"])
  })
})
