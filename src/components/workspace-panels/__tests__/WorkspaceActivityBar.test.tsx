import { useState, type ReactNode } from "react"
import { Circle } from "lucide-react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  availableWorkspacePanels,
  WorkspaceActivityBar,
  WorkspacePanelHost,
} from "../WorkspaceActivityBar"
import { DesktopWorkspacePanels } from "../DesktopWorkspacePanels"
import type {
  RegisteredWorkspacePanel,
  WorkspacePanelContext,
  WorkspacePanelProps,
} from "@/plugin-api"

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

const context: WorkspacePanelContext = {
  session: null,
  sessionChangeKey: 0,
  projectPath: "/repo",
  hasFileChanges: false,
  canAccessHostFiles: true,
  supportsWorktrees: true,
}

function StatefulPanel(_props: WorkspacePanelProps) {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>
}

function EmptyPanel(_props: WorkspacePanelProps) {
  return <div>Second panel</div>
}

const panels: RegisteredWorkspacePanel[] = [
  {
    id: "test.first",
    pluginId: "test",
    localId: "first",
    title: "First panel",
    icon: Circle,
    component: StatefulPanel,
    keepAlive: true,
  },
  {
    id: "test.second",
    pluginId: "test",
    localId: "second",
    title: "Second panel",
    icon: Circle,
    component: EmptyPanel,
  },
]

describe("WorkspaceActivityBar", () => {
  it("filters unavailable panels and reports the active selection", () => {
    const onTogglePanel = vi.fn()
    const filtered = [
      ...panels,
      { ...panels[1], id: "test.hidden", title: "Hidden panel", when: () => false },
    ]

    expect(availableWorkspacePanels(filtered, context)).toHaveLength(2)
    render(
      <WorkspaceActivityBar
        panels={filtered}
        context={context}
        activePanelId="test.first"
        onTogglePanel={onTogglePanel}
      />,
    )

    expect(screen.queryByRole("button", { name: "Hidden panel" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "First panel" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Second panel" }))
    expect(onTogglePanel).toHaveBeenCalledWith("test.second")
  })

  it("renders global destinations with the same active treatment as panels", () => {
    const openConfig = vi.fn()
    render(
      <WorkspaceActivityBar
        panels={panels}
        context={context}
        activePanelId={null}
        onTogglePanel={vi.fn()}
        actions={[
          { id: "mission", title: "Mission Control", icon: Circle, active: true, onSelect: vi.fn() },
          { id: "config", title: "Config", icon: Circle, active: false, onSelect: openConfig },
        ]}
      />,
    )

    expect(screen.getByRole("button", { name: "Mission Control" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Mission Control" })).toHaveClass("bg-sidebar-primary")
    fireEvent.click(screen.getByRole("button", { name: "Config" }))
    expect(openConfig).toHaveBeenCalledOnce()
  })

  it("keeps opted-in panels mounted while another panel is active", () => {
    const props = {
      panels,
      context,
      onClosePanel: vi.fn(),
      onOpenPanel: vi.fn(),
    }
    const { rerender } = render(
      <WorkspacePanelHost {...props} activePanelId="test.first" />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Count 0" }))
    rerender(<WorkspacePanelHost {...props} activePanelId="test.second" />)
    expect(screen.getByText("Second panel")).toBeVisible()

    rerender(<WorkspacePanelHost {...props} activePanelId="test.first" />)
    expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible()
  })

  it("keeps opted-in panels mounted in the integrated desktop layout", () => {
    const props = {
      children: <main>Main</main>,
      panels,
      context,
      services: {
        projectFilesRoot: "/repo",
        projectFilesRequest: null,
        backgroundAgents: [],
        searchInputRef: { current: null },
        addProjectContext: vi.fn(),
        jumpToTurn: vi.fn(),
        toggleServer: vi.fn(),
        serversChanged: vi.fn(),
        loadSession: vi.fn(),
        worktrees: { worktrees: [], loading: false, refetch: vi.fn() },
        worktreeDirName: "test",
        openWorktreeSession: vi.fn(),
      },
      onClosePanel: vi.fn(),
      onOpenPanel: vi.fn(),
      onTogglePanel: vi.fn(),
    }
    const { rerender } = render(
      <DesktopWorkspacePanels {...props} activePanel={panels[0]} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Count 0" }))
    rerender(<DesktopWorkspacePanels {...props} activePanel={panels[1]} />)
    expect(screen.getByText("Second panel")).toBeVisible()

    rerender(<DesktopWorkspacePanels {...props} activePanel={panels[0]} />)
    expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible()
  })
})
