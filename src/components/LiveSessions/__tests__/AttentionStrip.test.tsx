import * as React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AttentionStrip } from "../AttentionStrip"
import type { ActiveSessionInfo } from "../types"

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

describe("AttentionStrip working list", () => {
  it("shows compact working details without relative time", () => {
    const session = makeSession()
    const { container } = render(
      <AttentionStrip
        groups={{ needsYou: [], working: [session] }}
        activeSessionKey="agent-window/session.jsonl"
        procBySession={new Map()}
        killingPids={new Set()}
        sessionNames={{}}
        projectNames={{ "agent-window": "gentritbiba/agent-window" }}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText("Thinking")).toBeInTheDocument()
    expect(screen.getByText("gentritbiba/agent-window")).toBeInTheDocument()
    expect(container.querySelector("[data-working-list]")).toBeInTheDocument()
    expect(container.querySelector("[data-relative-time]")).toBeNull()
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
})
