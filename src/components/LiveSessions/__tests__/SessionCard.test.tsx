import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { SessionCard } from "../SessionCard"
import type { ActiveSessionInfo, RunningProcess } from "../types"

vi.mock("@/components/SessionContextMenu", () => ({
  SessionContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: renderProp, children }: { render?: ReactElement; children?: ReactNode }) => (
    isValidElement(renderProp)
      ? cloneElement(renderProp as ReactElement<{ children?: ReactNode }>, {}, children)
      : <>{children}</>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => <div data-testid="preview">{children}</div>,
}))

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "-work-app",
    projectShortName: "app",
    fileName: "s.jsonl",
    sessionId: "s1",
    cwd: "/work/app",
    lastModified: new Date().toISOString(),
    size: 100,
    ...overrides,
  }
}

function proc(): RunningProcess {
  return { pid: 4242, memMB: 100, cpu: 1, sessionId: "s1", tty: "ttys001", startTime: "10:00" }
}

function renderCard(overrides: Partial<ActiveSessionInfo> = {}, props: Partial<Parameters<typeof SessionCard>[0]> = {}) {
  const onSelectSession = vi.fn()
  render(
    <SessionCard
      session={session(overrides)}
      isActiveSession={false}
      proc={undefined}
      killingPids={new Set()}
      onSelectSession={onSelectSession}
      {...props}
    />,
  )
  return { onSelectSession }
}

afterEach(() => {
  cleanup()
  __resetEditionUiForTest()
})

/** The card's clickable body, as opposed to the hover preview beside it. */
function cardBody() {
  return within(document.querySelector("[data-live-session]") as HTMLElement)
}

describe("SessionCard", () => {
  it("carries the edition's badges for the session, given the row's access", () => {
    __installEditionUiForTest({ SessionBadges: ({ access }) => <span>Badge: {access?.level}</span> })
    renderCard({ access: { level: "view", mine: false } })

    expect(cardBody().getByText("Badge: view")).toBeInTheDocument()
  })

  it("shows the whole title, the last prompt, branch, turns and selects on click", () => {
    const title = "A title long enough that the compact row would have cut it off before the end"
    const { onSelectSession } = renderCard({
      aiTitle: title,
      lastUserMessage: "Please finish the sidebar",
      gitBranch: "feature/focus",
      turnCount: 7,
    })

    const body = cardBody()
    expect(body.getByText(title)).toBeInTheDocument()
    expect(body.getByText("Please finish the sidebar")).toBeInTheDocument()
    expect(body.getByText("feature/focus")).toBeInTheDocument()
    expect(body.getByText("7 turns")).toBeInTheDocument()

    fireEvent.click(body.getByText(title))
    expect(onSelectSession).toHaveBeenCalledWith("-work-app", "s.jsonl")
  })

  it("previews the project and the full first prompt on hover", () => {
    const first = "Set up the sidebar so I can focus on one project at a time without losing the others"
    renderCard({ aiTitle: "Sidebar focus", firstUserMessage: first, lastUserMessage: "now make it flat" }, { projectLabel: "App" })

    const preview = screen.getByTestId("preview")
    expect(preview).toHaveTextContent("App")
    expect(preview.querySelector("[data-first-prompt]")).toHaveTextContent(first)
    expect(preview.querySelector("[data-last-prompt]")).toHaveTextContent("now make it flat")
  })

  it("names the project on the card when asked, and only in the preview otherwise", () => {
    renderCard({ aiTitle: "Sidebar focus" }, { projectLabel: "App", showProject: true })
    expect(cardBody().getByText("App")).toBeInTheDocument()
    expect(screen.getByTestId("preview")).not.toHaveTextContent("App")
    cleanup()

    renderCard({ aiTitle: "Sidebar focus" }, { projectLabel: "App" })
    expect(cardBody().queryByText("App")).not.toBeInTheDocument()
    expect(screen.getByTestId("preview")).toHaveTextContent("App")
  })

  it("labels a session with no prompt as untitled instead of printing its id", () => {
    renderCard({ sessionId: "80725bd8-25cf-485f-95c2-ac45ff8bb105" })
    expect(cardBody().getByText("Untitled session")).toBeInTheDocument()
    expect(cardBody().queryByText(/80725bd8/)).not.toBeInTheDocument()
  })

  it("does not repeat the prompt when it is the title", () => {
    renderCard({ lastUserMessage: "Only prompt" })

    expect(cardBody().getAllByText("Only prompt")).toHaveLength(1)
  })

  it("marks a working session and offers to kill its process", () => {
    const onKill = vi.fn()
    renderCard({ agentStatus: "tool_use", agentToolName: "Bash" }, { proc: proc(), onKill })

    expect(document.querySelector('[data-status-dot="working"]')).not.toBeNull()
    expect(cardBody().getByText("Using Bash")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Kill process 4242" }))
    expect(onKill).toHaveBeenCalledWith(4242, expect.anything())
    expect(screen.queryByRole("button", { name: "Archive session" })).not.toBeInTheDocument()
  })

  it("offers to archive an idle session and to restore an archived one", () => {
    const onArchiveSession = vi.fn()
    renderCard({}, { onArchiveSession })
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }))
    expect(onArchiveSession).toHaveBeenCalledOnce()
    cleanup()

    const onUnarchiveSession = vi.fn()
    renderCard({ archived: true, archivedReason: "inactive" }, { onUnarchiveSession })
    expect(screen.getByLabelText("Archived after two weeks without activity")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore from archive" }))
    expect(onUnarchiveSession).toHaveBeenCalledOnce()
  })

  it("lets a deferred session be resumed and a team be folded", () => {
    const onResumeSession = vi.fn()
    const onToggleTeammates = vi.fn()
    renderCard({ agentStatus: "deferred" }, {
      onResumeSession,
      teammateCount: 2,
      teammatesCollapsed: true,
      onToggleTeammates,
    })

    expect(screen.getByText("deferred")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume to evaluate" }))
    expect(onResumeSession).toHaveBeenCalledWith("s1", "/work/app", "-work-app")
    fireEvent.click(screen.getByRole("button", { name: "Show 2 team agents" }))
    expect(onToggleTeammates).toHaveBeenCalledOnce()
  })
})

describe("SessionCard in a crew", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const member = (sessionId: string, overrides: Partial<ActiveSessionInfo> = {}) => session({
    sessionId,
    fileName: `${sessionId}.jsonl`,
    dirName: `-work-${sessionId}`,
    cwd: `/work/${sessionId}`,
    crew: { rootId: "s1", parentId: "s1", startedAt: 1 },
    lastActivityAt: minutesAgo(2),
    ...overrides,
  })
  const statuses: Record<string, { state: "needs-you" | "working" | "done"; need?: "permission" }> = {
    "w3-rooftop": { state: "needs-you", need: "permission" },
    "w3-storefront": { state: "working" },
    "w3-cost-model": { state: "done" },
  }
  const members = [
    member("w3-cost-model", { lastActivityAt: minutesAgo(120) }),
    member("w3-storefront", { agentStatus: "tool_use", agentToolName: "Bash" }),
    member("w3-rooftop", { lastActivityAt: minutesAgo(42) }),
    member("reviewer", { cwd: "/work/w3-rooftop", firstUserMessage: "Review packet r2", crew: { rootId: "s1", parentId: "w3-rooftop", startedAt: 2 } }),
  ]
  const statusOf = (value: ActiveSessionInfo) => statuses[value.sessionId] ?? { state: "done" as const }
  const crew = (open: boolean, onToggle = vi.fn()) => ({
    members,
    counts: { size: 4, needsYou: 1, working: 1, done: 2 },
    statusOf,
    activityAt: minutesAgo(0),
    open,
    onToggle,
  })

  it("closes with the crew's line, wears the crew's state and its latest activity", () => {
    const onToggle = vi.fn()
    renderCard({ lastActivityAt: minutesAgo(90), agentStatus: "completed" }, { crew: crew(false, onToggle) })

    const line = screen.getByRole("button", { name: "Show crew: Crew of 4, 1 need you, 1 working" })
    expect(line).toHaveTextContent("Crew· 4· 1 need you· 1 working")
    expect(document.querySelector("[data-status-dot]")).toHaveAttribute("data-status-dot", "attention")
    expect(document.querySelector("[data-crew-activity]")).toHaveTextContent("crew active now")
    expect(document.querySelector("[data-crew-member]")).toBeNull()

    fireEvent.click(line)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it("lists the sessions it started open: waiting first, then working, then done, each opening its session", () => {
    const { onSelectSession } = renderCard({}, { crew: crew(true) })

    const rows = [...document.querySelectorAll("[data-crew-member]")]
    // The reviewer w3-rooftop started is counted on its row, not listed.
    expect(rows.map((row) => row.getAttribute("data-crew-member"))).toEqual(["w3-rooftop", "w3-storefront", "w3-cost-model"])
    expect(rows[0]).toHaveTextContent("w3-rooftop · 1 session")
    expect(rows[0]).toHaveTextContent("permission · 42m")
    expect(rows[1]).toHaveTextContent("Bash")

    fireEvent.click(rows[0]!)
    expect(onSelectSession).toHaveBeenCalledWith("-work-w3-rooftop", "w3-rooftop.jsonl")
  })

  it("lists a deeper member that waits on someone, saying who started it", () => {
    const waiting = { ...crew(true), statusOf: (value: ActiveSessionInfo) => (value.sessionId === "reviewer" ? { state: "needs-you" as const, need: "permission" as const } : statusOf(value)) }
    renderCard({}, { crew: waiting })

    const reviewer = document.querySelector("[data-crew-member=reviewer]")
    expect(reviewer).toHaveTextContent("Review packet r2 · via w3-rooftop")
    expect(reviewer).toHaveTextContent("permission")
  })

  it("names who started a member listed on its own, in place of its project, and opens it", () => {
    const onOpenParent = vi.fn()
    renderCard({}, {
      showProject: true,
      projectLabel: "hcms-pr/w3-rooftop",
      lineage: { parentTitle: "w3-rooftop", rootTitle: "Wave 3 coordinator", onOpenParent },
    })

    expect(document.querySelector("[data-session-project]")).toBeNull()
    const eyebrow = screen.getByRole("button", { name: "Open w3-rooftop, which started this session" })
    expect(eyebrow).toHaveTextContent("w3-rooftop· Wave 3 coordinator")
    fireEvent.click(eyebrow)
    expect(onOpenParent).toHaveBeenCalledOnce()
  })
})
