import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FocusedProjectList } from "../FocusedProjectList"
import type { ActiveSessionInfo } from "../types"

vi.mock("../SessionCard", () => ({
  SessionCard: ({ session, teammateCount }: { session: ActiveSessionInfo; teammateCount?: number }) => (
    <div data-testid={`card-${session.sessionId}`}>{teammateCount ? `team:${teammateCount}` : null}</div>
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

function renderList(sessions: ActiveSessionInfo[], older = { canLoad: false, loading: false, load: vi.fn() }, pending?: string) {
  return render(
    <FocusedProjectList
      sessions={sessions}
      pendingSession={pending ? { dirName: "-work-app", firstMessage: pending } : null}
      older={older}
      activeSessionKey={null}
      procBySession={new Map()}
      killingPids={new Set()}
      newlyCompleted={new Set()}
      sessionNames={{}}
      onSelectSession={vi.fn()}
    />,
  )
}

afterEach(cleanup)

describe("FocusedProjectList", () => {
  it("renders every top-level session as a card with teammates nested as rows", () => {
    renderList([
      session("lead"),
      session("tm", { teamLeadSessionId: "lead", teamName: "t", agentName: "a" }),
      session("solo"),
    ])

    expect(screen.getByTestId("card-lead")).toHaveTextContent("team:1")
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
