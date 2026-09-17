import { cloneElement, type ReactElement, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionCard } from "../SessionCard"
import { SessionRow, type SessionRowProps } from "../SessionRow"

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement<{ children?: ReactNode }>; children: ReactNode }) => (
    cloneElement(render, {}, children)
  ),
  TooltipContent: () => null,
}))

afterEach(cleanup)

describe.each([SessionCard, SessionRow])("%s session actions", (Component) => {
  function props(): SessionRowProps {
    return {
      session: {
        dirName: "-work-app", projectShortName: "app", fileName: "s.jsonl",
        sessionId: "s1", lastModified: new Date().toISOString(), size: 100,
        agentStatus: "completed",
      },
      proc: { pid: 4242, memMB: 100, cpu: 0, sessionId: "s1", tty: "ttys001", startTime: "10:00" },
      isActiveSession: false,
      killingPids: new Set(),
      onSelectSession: vi.fn(),
      onKill: vi.fn(),
      onArchiveSession: vi.fn(),
      onUnarchiveSession: vi.fn(),
    }
  }

  it("replaces stop with archive when a tracked session completes, and restores stop on new work", () => {
    const p = props()
    const working = { ...p.session, agentStatus: "tool_use" as const }
    const { rerender } = render(<Component {...p} session={working} />)
    expect(screen.getByRole("button", { name: "Kill process 4242" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Archive session" })).not.toBeInTheDocument()

    rerender(<Component {...p} />)
    expect(screen.getByText("Done")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Kill process 4242" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Archive session" }))
    expect(p.onArchiveSession).toHaveBeenCalledWith(p.session)
    expect(p.onKill).not.toHaveBeenCalled()
    expect(p.onSelectSession).not.toHaveBeenCalled()

    fireEvent.contextMenu(document.querySelector("[data-live-session]")!)
    expect(screen.getByRole("menuitem", { name: "Archive session" })).not.toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive session" }))
    expect(p.onArchiveSession).toHaveBeenCalledTimes(2)

    rerender(<Component {...p} session={working} />)
    expect(screen.queryByRole("button", { name: "Archive session" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Kill process 4242" }))
    expect(p.onKill).toHaveBeenCalledWith(4242, expect.anything())
  })

  it("keeps stop while native activity is true even if the transcript still says completed", () => {
    const p = props()
    render(<Component {...p} session={{ ...p.session, isActive: true }} />)
    expect(screen.queryByRole("button", { name: "Archive session" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Kill process 4242" })).toBeInTheDocument()
  })

  it("offers only restore for an archived session with a lingering process", () => {
    const p = props()
    render(<Component {...p} session={{ ...p.session, archived: true }} />)
    expect(screen.queryByRole("button", { name: "Kill process 4242" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore from archive" }))
    expect(p.onUnarchiveSession).toHaveBeenCalledOnce()
    expect(p.onKill).not.toHaveBeenCalled()
  })
})
