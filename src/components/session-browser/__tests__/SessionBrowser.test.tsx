import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/LiveSessions", () => ({
  LiveSessions: () => <div>Live sessions</div>,
}))
vi.mock("@/components/TeamsList", () => ({
  TeamsList: () => <div>Teams</div>,
}))
vi.mock("@/components/ScriptsDock", () => ({
  ScriptsDock: ({ projectDir }: { projectDir: string }) => (
    <div data-testid="scripts-dock">{projectDir}</div>
  ),
}))
vi.mock("../BrowseTab", () => ({
  BrowseTab: () => <div>Browse</div>,
}))
vi.mock("../useSessionBrowser", () => ({
  useSessionBrowser: () => ({
    view: "projects",
    selectedProject: null,
    loadProjects: vi.fn(),
    loadSessions: vi.fn(),
    setFetchError: vi.fn(),
    loadLiveSession: vi.fn(),
  }),
}))

import { SessionBrowser } from "../SessionBrowser"

const baseProps = {
  sessionId: null,
  activeSessionKey: null,
  onLoadSession: vi.fn(),
  workerParse: vi.fn(),
  sidebarTab: "live" as const,
  onSidebarTabChange: vi.fn(),
}

describe("SessionBrowser scripts dock", () => {
  it("mounts the dock only when a desktop project is selected", () => {
    const { rerender } = render(
      <SessionBrowser {...baseProps} projectDir={null} />,
    )

    expect(screen.queryByTestId("scripts-dock")).toBeNull()

    rerender(<SessionBrowser {...baseProps} projectDir="/workspace/cogpit" />)

    expect(screen.getByTestId("scripts-dock")).toHaveTextContent("/workspace/cogpit")
  })

  it("keeps the dock hidden on mobile when a project is selected", () => {
    render(
      <SessionBrowser {...baseProps} projectDir="/workspace/cogpit" isMobile />,
    )

    expect(screen.queryByTestId("scripts-dock")).toBeNull()
  })
})
