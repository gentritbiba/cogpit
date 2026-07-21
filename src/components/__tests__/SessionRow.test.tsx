import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import * as React from "react"
import { SessionRow } from "../LiveSessions/SessionRow"
import type { ActiveSessionInfo } from "../LiveSessions/types"

// SessionRow uses Tooltip from base-ui — provide simple pass-through components
// so tests don't need to wire up full portal infrastructure.
// The TooltipTrigger in SessionRow uses `render={<div .../>}` as its trigger element
// and puts the row content as children. We render the trigger element and
// clone it with the children so the inner content is accessible in queries.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ render: renderProp, children }: { render?: React.ReactElement; children?: React.ReactNode }) => {
    if (renderProp && React.isValidElement(renderProp)) {
      return React.cloneElement(renderProp as React.ReactElement<{ children?: React.ReactNode }>, {}, children)
    }
    return React.createElement(React.Fragment, null, children)
  },
  TooltipContent: () => null,
}))

// SessionContextMenu wraps the row for context-menu support — pass through.
vi.mock("@/components/SessionContextMenu", () => ({
  SessionContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

function makeSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "test-dir",
    projectShortName: "Test Project",
    fileName: "session.jsonl",
    sessionId: "test-session-id-1234",
    firstUserMessage: "Hello world",
    lastUserMessage: "Hello world",
    lastModified: new Date().toISOString(),
    size: 1024,
    ...overrides,
  }
}

describe("SessionRow — deferred state", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the deferred pill when agentStatus is deferred", () => {
    render(
      <SessionRow
        session={makeSession({ agentStatus: "deferred" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
      />
    )
    expect(screen.getByText("deferred")).toBeInTheDocument()
  })

  it("does not render the deferred pill when agentStatus is not deferred", () => {
    render(
      <SessionRow
        session={makeSession({ agentStatus: "completed" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
      />
    )
    expect(screen.queryByText("deferred")).toBeNull()
  })

  it("renders Resume button when deferred and onResumeSession is provided", () => {
    render(
      <SessionRow
        session={makeSession({ agentStatus: "deferred" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
        onResumeSession={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: /resume to evaluate/i })).toBeInTheDocument()
  })

  it("does not render Resume button when onResumeSession is not provided", () => {
    render(
      <SessionRow
        session={makeSession({ agentStatus: "deferred" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
      />
    )
    expect(screen.queryByRole("button", { name: /resume to evaluate/i })).toBeNull()
  })

  it("calls onResumeSession with sessionId and cwd when Resume button is clicked", () => {
    const onResume = vi.fn()
    render(
      <SessionRow
        session={makeSession({ agentStatus: "deferred", cwd: "/home/user/project" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
        onResumeSession={onResume}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /resume to evaluate/i }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onResume).toHaveBeenCalledWith("test-session-id-1234", "/home/user/project")
  })

  it("does not call onSelectSession when Resume button is clicked (stopPropagation)", () => {
    const onSelect = vi.fn()
    const onResume = vi.fn()
    render(
      <SessionRow
        session={makeSession({ agentStatus: "deferred" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={onSelect}
        onKill={vi.fn()}
        onResumeSession={onResume}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /resume to evaluate/i }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("renders native Codex live state without a killable process", () => {
    render(
      <SessionRow
        session={makeSession({ isActive: true, agentStatus: "idle" })}
        isActiveSession={false}
        proc={undefined}
        killingPids={new Set()}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
      />
    )

    expect(screen.getByText("Running")).toHaveAttribute("data-session-live-state")
    expect(screen.queryByRole("button", { name: /kill process/i })).toBeNull()
  })
})
