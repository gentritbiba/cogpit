import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

const state = vi.hoisted(() => ({ sessions: [] as ActiveSessionInfo[] }))
const reveal = vi.hoisted(() => ({ path: vi.fn(), byId: vi.fn() }))

vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: state.sessions, procBySession: new Map() }),
}))
vi.mock("@/lib/revealSession", () => ({
  revealSessionPath: reveal.path,
  revealSessionById: reveal.byId,
  sessionPath: (dirName: string, fileName: string) => `/${dirName}/${fileName}`,
}))

import { CrewParentPill } from "../CrewParentPill"

function row(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return { dirName: `-work-${sessionId}`, projectShortName: sessionId, fileName: `${sessionId}.jsonl`, sessionId, lastModified: "", size: 1, ...overrides }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("CrewParentPill", () => {
  it("names the session that started this one and opens it", () => {
    state.sessions = [
      row("coordinator", { customTitle: "Wave 3 coordinator" }),
      row("lane", { crew: { rootId: "coordinator", parentId: "coordinator", startedAt: 1 } }),
    ]
    render(<CrewParentPill sessionId="lane" />)

    const pill = screen.getByRole("button", { name: /Reports to Wave 3 coordinator/ })
    fireEvent.click(pill)
    expect(reveal.path).toHaveBeenCalledWith("/-work-coordinator/coordinator.jsonl")
  })

  it("opens a parent the list does not carry by its id", () => {
    state.sessions = [row("lane", { crew: { rootId: "gone", parentId: "gone", startedAt: 1, parentTitle: "Old coordinator" } })]
    render(<CrewParentPill sessionId="lane" />)

    fireEvent.click(screen.getByRole("button", { name: /Reports to Old coordinator/ }))
    expect(reveal.byId).toHaveBeenCalledWith("gone")
  })

  it("renders nothing for a session nothing started", () => {
    state.sessions = [row("solo")]
    const { container } = render(<CrewParentPill sessionId="solo" />)
    expect(container).toBeEmptyDOMElement()
  })
})
