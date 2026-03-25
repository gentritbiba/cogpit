import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TabBar } from "@/components/TabBar"
import type { TabSnapshot } from "@/hooks/useTabState"

function makeTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id: "test-dir/test.jsonl",
    dirName: "test-dir",
    fileName: "test.jsonl",
    label: "Test Session",
    projectName: "test-dir",
    activeTurnIndex: null,
    activeToolCallId: null,
    searchQuery: "",
    expandAll: false,
    scrollTop: 0,
    hasUnreadActivity: false,
    lastKnownTurnCount: 0,
    cachedSession: null,
    cachedSource: null,
    pendingDirName: null,
    pendingCwd: null,
    ...overrides,
  }
}

describe("TabBar", () => {
  const defaultProps = {
    tabs: [] as TabSnapshot[],
    activeTabId: null as string | null,
    onSwitchTab: vi.fn(),
    onCloseTab: vi.fn(),
    onNewTab: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders nothing when no tabs are open", () => {
    const { container } = render(<TabBar {...defaultProps} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders tabs with labels", () => {
    const tabs = [
      makeTab({ id: "d1/f1.jsonl", label: "Session Alpha" }),
      makeTab({ id: "d2/f2.jsonl", label: "Session Beta" }),
    ]
    render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" />)

    expect(screen.getByText("Session Alpha")).toBeDefined()
    expect(screen.getByText("Session Beta")).toBeDefined()
  })

  it("highlights the active tab", () => {
    const tabs = [
      makeTab({ id: "d1/f1.jsonl", label: "Active" }),
      makeTab({ id: "d2/f2.jsonl", label: "Inactive" }),
    ]
    const { container } = render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" />)

    const activeTab = container.querySelector('[data-tab-id="d1/f1.jsonl"]')
    expect(activeTab?.className).toContain("border-accent")
  })

  it("calls onSwitchTab when clicking a tab", () => {
    const onSwitchTab = vi.fn()
    const tabs = [
      makeTab({ id: "d1/f1.jsonl", label: "Tab 1" }),
      makeTab({ id: "d2/f2.jsonl", label: "Tab 2" }),
    ]
    render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" onSwitchTab={onSwitchTab} />)

    fireEvent.click(screen.getByText("Tab 2"))
    expect(onSwitchTab).toHaveBeenCalledWith("d2/f2.jsonl")
  })

  it("calls onCloseTab when clicking close button", () => {
    const onCloseTab = vi.fn()
    const tabs = [makeTab({ id: "d1/f1.jsonl", label: "Tab 1" })]
    render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" onCloseTab={onCloseTab} />)

    const closeBtn = screen.getByLabelText("Close tab")
    fireEvent.click(closeBtn)
    expect(onCloseTab).toHaveBeenCalledWith("d1/f1.jsonl")
  })

  it("calls onCloseTab on middle-click", () => {
    const onCloseTab = vi.fn()
    const tabs = [makeTab({ id: "d1/f1.jsonl", label: "Tab 1" })]
    render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" onCloseTab={onCloseTab} />)

    const tabEl = screen.getByText("Tab 1")
    fireEvent.mouseDown(tabEl, { button: 1 })
    expect(onCloseTab).toHaveBeenCalledWith("d1/f1.jsonl")
  })

  it("shows activity dot on tabs with unread activity", () => {
    const tabs = [
      makeTab({ id: "d1/f1.jsonl", label: "Active Tab", hasUnreadActivity: false }),
      makeTab({ id: "d2/f2.jsonl", label: "Background Tab", hasUnreadActivity: true }),
    ]
    const { container } = render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" />)

    const bgTab = container.querySelector('[data-tab-id="d2/f2.jsonl"]')
    const dot = bgTab?.querySelector('[data-activity-dot]')
    expect(dot).not.toBeNull()
  })

  it("calls onNewTab when clicking the + button", () => {
    const onNewTab = vi.fn()
    const tabs = [makeTab({ id: "d1/f1.jsonl", label: "Tab 1" })]
    render(<TabBar {...defaultProps} tabs={tabs} activeTabId="d1/f1.jsonl" onNewTab={onNewTab} />)

    const addBtn = screen.getByLabelText("New tab")
    fireEvent.click(addBtn)
    expect(onNewTab).toHaveBeenCalled()
  })
})
