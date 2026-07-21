import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProjectGroupList } from "../ProjectGroupList"
import type { ActiveSessionInfo } from "../types"

vi.mock("@/components/ProjectContextMenu", () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("../SessionRow", () => ({
  SessionRow: ({
    session,
    teammateCount,
    teammatesCollapsed,
    onToggleTeammates,
  }: {
    session: ActiveSessionInfo
    teammateCount?: number
    teammatesCollapsed?: boolean
    onToggleTeammates?: () => void
  }) => (
    <div data-testid={`session-${session.sessionId}`}>
      <span>{session.sessionId}</span>
      {teammateCount !== undefined && (
        <button type="button" onClick={onToggleTeammates}>
          Toggle team for {session.sessionId}: {teammateCount}:{teammatesCollapsed ? "collapsed" : "expanded"}
        </button>
      )}
    </div>
  ),
}))

function session(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "project-a",
    projectShortName: "project-a",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    cwd: "/workspace/project-a",
    lastModified: "2026-07-21T10:00:00Z",
    size: 100,
    ...overrides,
  }
}

function renderGroups(
  grouped: Map<string, ActiveSessionInfo[]>,
  pending?: { projectPath: string; firstMessage: string },
) {
  return render(
    <ProjectGroupList
      grouped={grouped}
      pendingProjectPath={pending?.projectPath ?? null}
      pendingSession={pending ? {
        dirName: "pending-project",
        cwd: pending.projectPath,
        firstMessage: pending.firstMessage,
      } : null}
      collapsedGroups={{}}
      searchQuery=""
      activeSessionKey={null}
      procBySession={new Map()}
      killingPids={new Set()}
      newlyCompleted={new Set()}
      sessionNames={{}}
      projectNames={{}}
      onToggleCollapsed={vi.fn()}
      onSelectSession={vi.fn()}
      onKill={vi.fn()}
    />,
  )
}

afterEach(cleanup)

describe("ProjectGroupList", () => {
  it("nests teammate sessions under their lead and keeps the team independently collapsible", () => {
    const lead = session("lead")
    const teammate = session("teammate", { teamLeadSessionId: "lead" })
    renderGroups(new Map([["/workspace/project-a", [lead, teammate]]]))

    expect(screen.getByTestId("session-teammate")).toBeInTheDocument()
    const toggle = screen.getByRole("button", { name: "Toggle team for lead: 1:expanded" })
    fireEvent.click(toggle)

    expect(screen.queryByTestId("session-teammate")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Toggle team for lead: 1:collapsed" })).toBeInTheDocument()
  })

  it("renders a pending session in a new project group before its inventory exists", () => {
    renderGroups(new Map(), {
      projectPath: "/workspace/new-project",
      firstMessage: "Bootstrap the feature",
    })

    expect(screen.getByText("/workspace/new-project")).toBeInTheDocument()
    expect(screen.getByText("Bootstrap the feature")).toBeInTheDocument()
  })

  it("uses progressive disclosure instead of a nested session scrollbar", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(`session-${index + 1}`))
    renderGroups(new Map([["/workspace/project-a", sessions]]))

    expect(screen.queryByTestId("session-session-6")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }))

    expect(screen.getByTestId("session-session-6")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument()
  })
})
