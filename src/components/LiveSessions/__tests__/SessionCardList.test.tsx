import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionCardList } from "../SessionCardList"
import type { SessionRowProps } from "../SessionRow"
import type { ActiveSessionInfo } from "../types"
import type { SessionAccessLevel } from "../../../../shared/contracts/sessionAccess"

const ROW_ACTIONS = [
  "onKill",
  "onDuplicateSession",
  "onDeleteSession",
  "onArchiveSession",
  "onUnarchiveSession",
  "onResumeSession",
] as const

vi.mock("../SessionCard", () => ({
  SessionCard: (props: SessionRowProps & {
    teammateCount?: number
    projectLabel?: string
    showProject?: boolean
    crew?: { members: ActiveSessionInfo[]; counts: { needsYou: number }; open: boolean; onToggle: () => void }
    lineage?: { parentTitle: string; rootTitle?: string }
  }) => {
    const { session, teammateCount, projectLabel, showProject, crew, lineage } = props
    return (
      <div
        data-testid={`card-${session.sessionId}`}
        data-actions={ROW_ACTIONS.filter((action) => props[action]).join(",")}
        data-crew={crew?.members.map((member) => member.sessionId).join(",")}
        data-crew-waiting={crew?.counts.needsYou}
        data-lineage={lineage ? [lineage.parentTitle, lineage.rootTitle].filter(Boolean).join(" / ") : undefined}
      >
        {projectLabel} {teammateCount ? `team:${teammateCount}` : null}{showProject ? `project:${projectLabel}` : null}
      </div>
    )
  },
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

describe("SessionCardList access", () => {
  function renderWithActions(access?: SessionAccessLevel) {
    render(
      <SessionCardList
        sessions={[session("s", access ? { access: { level: access, mine: access === "own" } } : {})]}
        older={{ canLoad: false, loading: false, load: vi.fn() }}
        activeSessionKey={null}
        procBySession={new Map()}
        killingPids={new Set()}
        newlyCompleted={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
        onDuplicateSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onResumeSession={vi.fn()}
      />,
    )
    return screen.getByTestId("card-s").dataset.actions?.split(",")
  }

  it.each([
    [undefined, ROW_ACTIONS],
    ["own", ROW_ACTIONS],
    ["interact", ["onKill", "onDuplicateSession", "onResumeSession"]],
    ["view", ["onDuplicateSession"]],
  ] as const)("offers a %s session only the actions its level allows", (level, actions) => {
    expect(renderWithActions(level)).toEqual(actions)
  })
})

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

  describe("crews", () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const coordinator = session("coordinator", { customTitle: "Wave 3 coordinator", lastActivityAt: minutesAgo(90) })
    const lane = session("lane", {
      cwd: "/work/w3-rooftop",
      lastActivityAt: minutesAgo(1),
      crew: { rootId: "coordinator", parentId: "coordinator", startedAt: 1 },
    })
    const reviewer = session("reviewer", {
      cwd: "/work/w3-rooftop",
      lastActivityAt: minutesAgo(5),
      crew: { rootId: "coordinator", parentId: "lane", startedAt: 2 },
    })
    const solo = session("solo", { lastActivityAt: minutesAgo(30) })

    function renderCrews(sessions: ActiveSessionInfo[], props: Partial<Parameters<typeof SessionCardList>[0]> = {}) {
      render(
        <SessionCardList
          sessions={sessions}
          older={{ canLoad: false, loading: false, load: vi.fn() }}
          activeSessionKey={null}
          procBySession={new Map()}
          killingPids={new Set()}
          newlyCompleted={new Set()}
          sessionNames={{}}
          projectNames={{}}
          onSelectSession={vi.fn()}
          {...props}
        />,
      )
      return [...document.querySelectorAll("[data-testid^=card-]")].map((el) => el.getAttribute("data-testid"))
    }

    it("lists a crew as its root, placed by the crew's latest activity, with every member in its line", () => {
      expect(renderCrews([solo, reviewer, coordinator, lane])).toEqual(["card-coordinator", "card-solo"])
      expect(screen.getByTestId("card-coordinator").dataset.crew).toBe("lane,reviewer")
    })

    it("names who started a member listed on its own, and its crew's root", () => {
      renderCrews([reviewer], { lineageSessions: [coordinator, lane, reviewer] })
      expect(screen.getByTestId("card-reviewer").dataset.lineage).toBe("w3-rooftop / Wave 3 coordinator")
    })

    it("falls back to the titles the server sent for a lineage it does not list", () => {
      renderCrews([{ ...lane, crew: { ...lane.crew!, parentTitle: "Wave 3 coordinator", rootTitle: "Wave 3 coordinator" } }])
      expect(screen.getByTestId("card-lane").dataset.lineage).toBe("Wave 3 coordinator")
    })

    it("lists every session on its own when crews are not grouped", () => {
      expect(renderCrews([coordinator, lane], { groupCrews: false })).toEqual(["card-lane", "card-coordinator"])
      expect(screen.getByTestId("card-lane").dataset.lineage).toBe("Wave 3 coordinator")
    })

    it("counts the members waiting on someone", () => {
      renderCrews([coordinator, lane, reviewer], {
        memberStatusOf: (member) => (member.sessionId === "reviewer" ? { state: "needs-you", need: "permission" } : { state: "working" }),
      })
      expect(screen.getByTestId("card-coordinator").dataset.crewWaiting).toBe("1")
    })
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
