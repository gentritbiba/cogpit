import { useState } from "react"
import { Circle } from "lucide-react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MobileWorkspacePanels } from "../MobileWorkspacePanels"
import type { RegisteredWorkspacePanel, WorkspacePanelContext, WorkspacePanelProps } from "@/plugin-api"

afterEach(cleanup)

const context: WorkspacePanelContext = {
  session: null, sessionChangeKey: 0, projectPath: "/repo/project", hasFileChanges: false,
  canAccessHostFiles: true, supportsWorktrees: true,
}

function Preview({ active }: WorkspacePanelProps) {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>Preview {count}, {active ? "live" : "paused"}</button>
}

const panels: RegisteredWorkspacePanel[] = [
  { id: "test.browser", pluginId: "test", localId: "browser", title: "Browser", icon: Circle, component: Preview, keepAlive: true, when: (value) => value.canAccessHostFiles },
  { id: "test.details", pluginId: "test", localId: "details", title: "Session details", icon: Circle, component: Preview, when: (value) => value.session !== null },
  { id: "plugin.custom", pluginId: "plugin", localId: "custom", title: "Custom plugin", icon: Circle, component: Preview, badge: () => 3 },
]

const props = { panels, context, activePanelId: null, active: true, onSelectPanel: vi.fn(), onClosePanel: vi.fn() }

describe("MobileWorkspacePanels", () => {
  it("uses the desktop registry and capability rules, including plugin panels", () => {
    render(<MobileWorkspacePanels {...props} />)
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Session details" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Custom plugin" }))
    expect(props.onSelectPanel).toHaveBeenCalledWith("plugin.custom")
    expect(screen.getByText("project")).toBeInTheDocument()
  })

  it("opens the real panel and returns to the chooser", () => {
    render(<MobileWorkspacePanels {...props} activePanelId="test.browser" />)
    expect(screen.getByRole("heading", { name: "Browser" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview 0, live" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "All workspace tools" }))
    expect(props.onClosePanel).toHaveBeenCalled()
  })

  it("pauses a hidden browser while retaining its state across chat and chooser navigation", () => {
    const { rerender } = render(<MobileWorkspacePanels {...props} activePanelId="test.browser" />)
    fireEvent.click(screen.getByRole("button", { name: "Preview 0, live" }))
    rerender(<MobileWorkspacePanels {...props} activePanelId="test.browser" active={false} />)
    expect(screen.getByText("Preview 1, paused")).toBeInTheDocument()
    rerender(<MobileWorkspacePanels {...props} />)
    expect(screen.getByText("Preview 1, paused")).toBeInTheDocument()
    rerender(<MobileWorkspacePanels {...props} activePanelId="test.browser" />)
    expect(screen.getByRole("button", { name: "Preview 1, live" })).toBeInTheDocument()
  })

  it("returns to available tools when the selected panel loses its capability", () => {
    const { rerender } = render(<MobileWorkspacePanels {...props} activePanelId="test.browser" />)
    rerender(<MobileWorkspacePanels {...props} activePanelId="test.browser" context={{ ...context, canAccessHostFiles: false }} />)
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Browser" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Preview/)).not.toBeInTheDocument()
  })

  it("shows global actions and pauses the selected panel while a global tool is open", () => {
    render(<MobileWorkspacePanels {...props} activePanelId="test.browser" actions={[
      { id: "config", title: "Config", icon: Circle, active: true, onSelect: vi.fn() },
    ]} actionContent={<div>Configuration editor</div>} />)
    expect(screen.getByRole("heading", { name: "Config" })).toBeInTheDocument()
    expect(screen.getByText("Configuration editor")).toBeInTheDocument()
    expect(screen.getByText("Preview 0, paused")).toBeInTheDocument()
  })
})
