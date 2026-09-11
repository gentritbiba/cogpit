import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionCard } from "../SessionCard"
import type { ActiveSessionInfo, RunningProcess } from "../types"

vi.mock("@/components/SessionContextMenu", () => ({
  SessionContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
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

describe("SessionCard", () => {
  it("shows the whole title, the last prompt, branch, turns and selects on click", () => {
    const title = "A title long enough that the compact row would have cut it off before the end"
    const { onSelectSession } = renderCard({
      aiTitle: title,
      lastUserMessage: "Please finish the sidebar",
      gitBranch: "feature/focus",
      turnCount: 7,
    })

    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText("Please finish the sidebar")).toBeInTheDocument()
    expect(screen.getByText("feature/focus")).toBeInTheDocument()
    expect(screen.getByText("7 turns")).toBeInTheDocument()

    fireEvent.click(screen.getByText(title))
    expect(onSelectSession).toHaveBeenCalledWith("-work-app", "s.jsonl")
  })

  it("does not repeat the prompt when it is the title", () => {
    renderCard({ lastUserMessage: "Only prompt" })

    expect(screen.getAllByText("Only prompt")).toHaveLength(1)
  })

  it("marks a working session and offers to kill its process", () => {
    const onKill = vi.fn()
    renderCard({ agentStatus: "tool_use", agentToolName: "Bash" }, { proc: proc(), onKill })

    expect(document.querySelector('[data-status-dot="working"]')).not.toBeNull()
    expect(screen.getByText("Using Bash")).toBeInTheDocument()
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
