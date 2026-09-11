import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionCardList } from "../SessionCardList"
import type { ActiveSessionInfo } from "../types"

vi.mock("../SessionCard", () => ({
  SessionCard: ({ session, teammateCount, projectLabel, showProject }: { session: ActiveSessionInfo; teammateCount?: number; projectLabel?: string; showProject?: boolean }) => (
    <div data-testid={`card-${session.sessionId}`}>{projectLabel} {teammateCount ? `team:${teammateCount}` : null}{showProject ? `project:${projectLabel}` : null}</div>
  ),
}))
vi.mock("../SessionRow", () => ({
  SessionRow: ({ session }: { session: ActiveSessionInfo }) => <div data-testid={`row-${session.sessionId}`} />,
}))

function session(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "-work-app",
    projectShortName: "app",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    cwd: "/work/app",
    lastModified: "2026-09-10T10:00:00Z",
    size: 100,
    ...overrides,
  }
}

function renderList(
  sessions: ActiveSessionInfo[],
  older = { canLoad: false, loading: false, load: vi.fn() },
  pending?: string,
  showProject = false,
) {
  return render(
    <SessionCardList
      sessions={sessions}
      pendingSession={pending ? { dirName: "-work-app", firstMessage: pending } : null}
      older={older}
      showProject={showProject}
      activeSessionKey={null}
      procBySession={new Map()}
      killingPids={new Set()}
      newlyCompleted={new Set()}
      sessionNames={{}}
      projectNames={{ "-work-app": "App" }}
      onSelectSession={vi.fn()}
    />,
  )
}

afterEach(cleanup)

describe("SessionCardList", () => {
  it("separates the run of cards by when they were last touched, newest first", () => {
    const today = new Date().toISOString()
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    renderList([
      session("old", { lastModified: twoDaysAgo }),
      session("new", { lastModified: today }),
    ])

    const labels = [...document.querySelectorAll("[data-recency-divider]")].map((el) => el.textContent)
    expect(labels).toEqual(["Today", "Last 7 days"])
    const order = [...document.querySelectorAll("[data-testid^=card-]")].map((el) => el.getAttribute("data-testid"))
    expect(order).toEqual(["card-new", "card-old"])
  })

  it("tells each card whether to name its project", () => {
    renderList([session("a")], undefined, undefined, true)
    expect(screen.getByTestId("card-a")).toHaveTextContent("project:App")
  })

  it("renders every top-level session as a card with teammates nested as rows", () => {
    renderList([
      session("lead"),
      session("tm", { teamLeadSessionId: "lead", teamName: "t", agentName: "a" }),
      session("solo"),
    ])

    expect(screen.getByTestId("card-lead")).toHaveTextContent("App team:1")
    expect(screen.getByTestId("row-tm")).toBeInTheDocument()
    expect(screen.getByTestId("card-solo")).toBeInTheDocument()
    expect(screen.queryByTestId("card-tm")).not.toBeInTheDocument()
  })

  it("shows the pending session first and offers older sessions until they are loaded", () => {
    const load = vi.fn()
    renderList([session("a")], { canLoad: true, loading: false, load }, "Starting up")

    expect(screen.getByText("Starting up")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Load older sessions" }))
    expect(load).toHaveBeenCalledOnce()
    cleanup()

    renderList([session("a")])
    expect(screen.queryByRole("button", { name: "Load older sessions" })).not.toBeInTheDocument()
  })
})
