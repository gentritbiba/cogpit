import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { InSession } from "@/__tests__/InSession"
import { builtInWorkspacePlugin } from "../builtInWorkspacePlugin"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"
import { collectWorkspacePanels, type WorkspacePanelContext } from "@/plugin-api"
import type { ToolCall, Turn } from "../../../../shared/session/types"
import { type SessionView, EMPTY_SESSION_DIGEST } from "../../../../shared/session/sessionDigest"

const panels = collectWorkspacePanels([builtInWorkspacePlugin])

function contextOf(overrides: Partial<WorkspacePanelContext> = {}): WorkspacePanelContext {
  return {
    sessionId: null,
    sessionChangeKey: 0,
    projectPath: "/repo",
    hasFileChanges: false,
    canAccessHostFiles: true,
    canUseBrowser: true,
    ...overrides,
  }
}

const walks = vi.hoisted(() => ({ count: 0 }))
vi.mock("../../../../shared/session/browserActivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../shared/session/browserActivity")>()
  return {
    ...actual,
    latestBrowserActivity: (...args: Parameters<typeof actual.latestBrowserActivity>) => {
      walks.count++
      return actual.latestBrowserActivity(...args)
    },
  }
})

function inSession(session: SessionView, node: ReactNode) {
  return <InSession session={session}>{node}</InSession>
}

function sessionDrivingAt(timestamp: string): SessionView {
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
    digest: EMPTY_SESSION_DIGEST,
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

  it("registers the Views panel after the Browser, kept mounted and open to everyone", () => {
    const panel = panels.find((entry) => entry.id === BUILT_IN_WORKSPACE_PANEL_IDS.views)
    if (!panel) throw new Error("the Views panel is not registered")

    expect(panel.title).toBe("Views")
    expect(panel.keepAlive).toBe(true)
    expect(panel.when).toBeUndefined()
    const order = panels.map((entry) => entry.id)
    expect(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.views))
      .toBe(order.indexOf(BUILT_IN_WORKSPACE_PANEL_IDS.browser) + 1)
  })

  it("shows the Browser panel to whoever may use it, host files or not", () => {
    const panel = browserPanel()

    expect(panel.when?.(contextOf())).toBe(true)
    // An account that reaches no host file still watches its agents' browsers.
    expect(panel.when?.(contextOf({ canAccessHostFiles: false }))).toBe(true)
    expect(panel.when?.(contextOf({ canUseBrowser: false }))).toBe(false)
  })

  it("marks the Browser icon only while the agent is browsing", () => {
    const Indicator = browserPanel().indicator
    if (!Indicator) throw new Error("the Browser panel has no indicator")
    const dot = { name: "The agent is using the browser" }

    const idle = render(<Indicator context={contextOf()} active={false} />)
    expect(screen.queryByRole("status", dot)).not.toBeInTheDocument()
    idle.unmount()

    const stale = render(inSession(
      sessionDrivingAt(new Date(Date.now() - 60_000).toISOString()),
      <Indicator context={contextOf({ sessionId: "cogpit-1" })} active={false} />,
    ))
    expect(screen.queryByRole("status", dot)).not.toBeInTheDocument()
    stale.unmount()

    render(inSession(
      sessionDrivingAt(new Date().toISOString()),
      <Indicator context={contextOf({ sessionId: "cogpit-1" })} active={false} />,
    ))
    expect(screen.getByRole("status", dot)).toBeInTheDocument()
  })

  it("walks the transcript for browser activity only when the session changes", () => {
    const Indicator = browserPanel().indicator
    if (!Indicator) throw new Error("the Browser panel has no indicator")
    const session = sessionDrivingAt(new Date().toISOString())
    const view = render(inSession(session, <Indicator context={contextOf({ sessionId: "cogpit-1" })} active={false} />))
    const walked = walks.count

    // The rail re-renders the indicator with a fresh context object.
    view.rerender(inSession(session, <Indicator context={contextOf({ sessionId: "cogpit-1" })} active />))
    view.rerender(inSession(session, <Indicator context={contextOf({ sessionId: "cogpit-1" })} active={false} />))

    expect(walks.count).toBe(walked)
  })
})
