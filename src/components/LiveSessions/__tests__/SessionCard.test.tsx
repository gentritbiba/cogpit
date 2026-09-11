import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

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

afterEach(cleanup)

/** The card's clickable body, as opposed to the hover preview beside it. */
function cardBody() {
  return within(document.querySelector("[data-live-session]") as HTMLElement)
}

describe("SessionCard", () => {
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
