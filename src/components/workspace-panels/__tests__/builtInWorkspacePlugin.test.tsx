import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { builtInWorkspacePlugin } from "../builtInWorkspacePlugin"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"
import { collectWorkspacePanels, type WorkspacePanelContext } from "@/plugin-api"
import type { ParsedSession, ToolCall, Turn } from "../../../../shared/session/types"

const panels = collectWorkspacePanels([builtInWorkspacePlugin])

function contextOf(overrides: Partial<WorkspacePanelContext> = {}): WorkspacePanelContext {
  return {
    session: null,
    sessionChangeKey: 0,
    projectPath: "/repo",
    hasFileChanges: false,
    canAccessHostFiles: true,
    ...overrides,
  }
}

function sessionDrivingAt(timestamp: string): ParsedSession {
  const call: ToolCall = {
    id: "tool-1",
    name: "Bash",
    input: { command: "agent-browser open https://example.com" },
    result: null,
    isError: false,
    timestamp,
  }
  const turn: Turn = {
    id: "turn-1",
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [call],
    subAgentActivity: [],
    timestamp,
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
  return {
    sessionId: "cogpit-1",
    version: "1",
    gitBranch: "browser-panel",
    cwd: "/repo",
    slug: "",
    name: "",
    model: "",
    turns: [turn],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 1,
    },
    rawMessages: [],
  }
}

function browserPanel() {
  const panel = panels.find((entry) => entry.id === BUILT_IN_WORKSPACE_PANEL_IDS.browser)
  if (!panel) throw new Error("the Browser panel is not registered")
  return panel
}

describe("builtInWorkspacePlugin", () => {
  it("registers the Browser panel between project files and file changes", () => {
    const panel = browserPanel()

    expect(panel.title).toBe("Browser")
    expect(panel.keepAlive).toBe(true)
    expect(panel.defaultSize).toBe("46%")
    expect(panel.minSize).toBe("360px")
    expect(panel.maxSize).toBe("75%")

    const order = panels.map((entry) => entry.id)
    expect(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.browser))
      .toBeGreaterThan(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles))
    expect(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.browser))
      .toBeLessThan(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges))
  })

  it("hides the Browser panel where the host has no files of its own", () => {
    const panel = browserPanel()

    expect(panel.when?.(contextOf())).toBe(true)
    expect(panel.when?.(contextOf({ canAccessHostFiles: false }))).toBe(false)
  })

  it("marks the Browser icon only while the agent is browsing", () => {
    const Indicator = browserPanel().indicator
    if (!Indicator) throw new Error("the Browser panel has no indicator")
    const dot = { name: "The agent is using the browser" }

    const idle = render(<Indicator context={contextOf()} active={false} />)
    expect(screen.queryByRole("status", dot)).not.toBeInTheDocument()
    idle.unmount()

    const stale = render(
      <Indicator
        context={contextOf({ session: sessionDrivingAt(new Date(Date.now() - 60_000).toISOString()) })}
        active={false}
      />,
    )
    expect(screen.queryByRole("status", dot)).not.toBeInTheDocument()
    stale.unmount()

    render(
      <Indicator
        context={contextOf({ session: sessionDrivingAt(new Date().toISOString()) })}
        active={false}
      />,
    )
    expect(screen.getByRole("status", dot)).toBeInTheDocument()
  })
})
