import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AttentionStrip } from "../AttentionStrip"
import type { ActiveSessionInfo, RunningProcess } from "../types"

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: trigger, children }: { render: React.ReactElement; children: React.ReactNode }) =>
    React.cloneElement(trigger as React.ReactElement<{ children?: React.ReactNode }>, {}, children),
  TooltipContent: () => null,
}))

function makeSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "agent-window",
    projectShortName: "agent-window",
    fileName: "session.jsonl",
    sessionId: "session-1",
    firstUserMessage: "Clean up the working section",
    lastModified: "2026-08-19T08:00:00.000Z",
    size: 1024,
    isActive: true,
    agentStatus: "thinking",
    ...overrides,
  }
}

const WORKING_OPEN_KEY = "live-sessions-working-open"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function renderWorking(working: ActiveSessionInfo[], extra: Partial<Parameters<typeof AttentionStrip>[0]> = {}) {
  return render(
    <AttentionStrip
      groups={{ needsYou: [], working }}
      activeSessionKey="agent-window/session.jsonl"
      procBySession={new Map()}
      killingPids={new Set()}
      sessionNames={{}}
      projectNames={{ "agent-window": "gentritbiba/agent-window" }}
      onSelectSession={vi.fn()}
      {...extra}
    />,
  )
}

describe("AttentionStrip working list", () => {
  it("folds the roll call by default and says how many are working", () => {
    const { container } = renderWorking([makeSession()])

    const toggle = screen.getByRole("button", { name: /Working/ })
    expect(toggle).toHaveTextContent("Working")
    expect(toggle).toHaveTextContent("1")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(container.querySelector("[data-working-list]")).toBeNull()
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument()
  })

  it("unfolds the roll call on click as one line per session, without time or project", () => {
    const onSelectSession = vi.fn()
    const { container } = renderWorking([makeSession()], { onSelectSession })

    const toggle = screen.getByRole("button", { name: /Working/ })
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(container.querySelector("[data-working-list]")).toBeInTheDocument()
    expect(screen.getByText("Thinking")).toBeInTheDocument()
    expect(screen.getByText("Clean up the working section")).toBeInTheDocument()
    expect(screen.queryByText("gentritbiba/agent-window")).not.toBeInTheDocument()
    expect(container.querySelector("[data-relative-time]")).toBeNull()

    fireEvent.click(container.querySelector("[data-working-list] [data-attention-session]")!)
    expect(onSelectSession).toHaveBeenCalledWith("agent-window", "session.jsonl")

    fireEvent.click(toggle)
    expect(container.querySelector("[data-working-list]")).toBeNull()
  })

  it("remembers whether the roll call is open", () => {
    renderWorking([makeSession()])
    fireEvent.click(screen.getByRole("button", { name: /Working/ }))
    expect(localStorage.getItem(WORKING_OPEN_KEY)).toBe("true")
    cleanup()

    const { container } = renderWorking([makeSession()])
    expect(screen.getByRole("button", { name: /Working/ })).toHaveAttribute("aria-expanded", "true")
    expect(container.querySelector("[data-working-list]")).toBeInTheDocument()
  })

  it("shows the first rows of a long roll call and the rest on request", () => {
    const sessions = Array.from({ length: 8 }, (_, i) => makeSession({
      sessionId: `s${i}`,
      fileName: `s${i}.jsonl`,
      firstUserMessage: `Task ${i}`,
    }))
    const { container } = renderWorking(sessions)

    fireEvent.click(screen.getByRole("button", { name: /Working/ }))
    expect(container.querySelectorAll("[data-working-list] [data-attention-session]")).toHaveLength(6)

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }))
    expect(container.querySelectorAll("[data-working-list] [data-attention-session]")).toHaveLength(8)
  })

  it("keeps needs-you rows visible while the roll call is folded", () => {
    const waiting = makeSession({ sessionId: "w", fileName: "w.jsonl", firstUserMessage: "Approve the plan" })
    renderWorking([makeSession()], {
      groups: { needsYou: [{ session: waiting, reason: "plan" }], working: [makeSession()] },
    })

    expect(screen.getByText("Approve the plan")).toBeInTheDocument()
    expect(screen.getByText("Review plan")).toBeInTheDocument()
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument()
  })

  it("opens a session that needs Copilot plan review", () => {
    const session = makeSession()
    const onSelectSession = vi.fn()
    render(
      <AttentionStrip
        groups={{ needsYou: [{ session, reason: "plan" }], working: [] }}
        activeSessionKey={null}
        procBySession={new Map()}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={onSelectSession}
      />,
    )

    const chip = screen.getByText("Review plan")
    fireEvent.click(chip.closest("button")!)
    expect(onSelectSession).toHaveBeenCalledWith("agent-window", "session.jsonl")
  })

  it("removes lifecycle controls for an externally owned Copilot session", () => {
    const session = makeSession({
      dirName: "copilot__L3RtcC9wcm9qZWN0",
      agentStatus: "deferred",
    })
    const process: RunningProcess = {
      pid: 4242,
      memMB: 100,
      cpu: 1,
      sessionId: session.sessionId,
      agentKind: "copilot",
      managed: false,
      tty: "ttys001",
      startTime: "10:00",
    }

    render(
      <AttentionStrip
        groups={{ needsYou: [{ session, reason: "deferred" }], working: [] }}
        activeSessionKey={null}
        procBySession={new Map([[session.sessionId, process]])}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
        onResumeSession={vi.fn()}
      />,
    )

    expect(screen.getByText("Read-only")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /resume to evaluate/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /kill process/i })).toBeNull()
  })

  it.each([
    ["view", false],
    ["interact", true],
  ] as const)("gives a %s session its lifecycle controls only when it can interact", (level, shown) => {
    const session = makeSession({
      agentStatus: "deferred",
      access: { level, mine: false },
    })
    const process: RunningProcess = {
      pid: 4242, memMB: 100, cpu: 1, sessionId: session.sessionId, tty: "ttys001", startTime: "10:00",
    }

    render(
      <AttentionStrip
        groups={{ needsYou: [{ session, reason: "deferred" }], working: [] }}
        activeSessionKey={null}
        procBySession={new Map([[session.sessionId, process]])}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={vi.fn()}
        onKill={vi.fn()}
        onResumeSession={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: /resume to evaluate/i }) !== null).toBe(shown)
    expect(screen.queryByRole("button", { name: /kill process/i }) !== null).toBe(shown)
  })
})

describe("AttentionStrip crews", () => {
  const root = makeSession({ sessionId: "root", firstUserMessage: "Wave 3 coordinator", agentStatus: "completed", isActive: false })

  it("lists a crew as its root, saying how many members wait and since when", () => {
    const longestWaitSince = new Date(Date.now() - 42 * 60_000).toISOString()
    render(
      <AttentionStrip
        groups={{ needsYou: [{ session: root, reason: "crew", crew: { size: 15, needsYou: 2, working: 2, done: 11, longestWaitSince } }], working: [] }}
        activeSessionKey={null}
        procBySession={new Map()}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.getByText("Wave 3 coordinator")).toBeInTheDocument()
    expect(screen.getByText("2 waiting")).toBeInTheDocument()
    expect(screen.getByText("42m")).toBeInTheDocument()
  })

  it("says a root works through its crew when it does not work itself", () => {
    render(
      <AttentionStrip
        groups={{ needsYou: [], working: [root], workingCrews: new Map([["root", { size: 3, needsYou: 0, working: 2, done: 1 }]]) }}
        activeSessionKey={null}
        procBySession={new Map()}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{}}
        onSelectSession={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Working/ }))
    expect(screen.getByText("2 in crew")).toBeInTheDocument()
  })
})
