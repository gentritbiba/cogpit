import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"
import { cloneElement, isValidElement } from "react"

import { LiveSessionsFeedback, LiveSessionsToolbar } from "../LiveSessionsChrome"

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: renderProp, children }: { render?: ReactElement; children?: ReactNode }) => (
    isValidElement(renderProp)
      ? cloneElement(renderProp as ReactElement<{ children?: ReactNode }>, {}, children)
      : <>{children}</>
  ),
  TooltipContent: () => null,
}))

function renderToolbar(overrides: Partial<Parameters<typeof LiveSessionsToolbar>[0]> = {}) {
  const props = {
    loading: false,
    isMobile: false,
    searchQuery: "",
    searchLoading: false,
    showArchived: false,
    archivedCount: 0,
    onSearchQueryChange: vi.fn(),
    onToggleShowArchived: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  }
  return { ...render(<LiveSessionsToolbar {...props} />), props }
}

describe("LiveSessionsToolbar", () => {
  it("places the archive toggle and refresh after the search box without a sessions heading", () => {
    const { container, props } = renderToolbar()

    const toolbar = container.firstElementChild
    const search = screen.getByRole("searchbox")
    const searchBox = search.closest('[data-slot="input-group"]')
    const archive = screen.getByRole("button", { name: "Show archived sessions" })
    const refresh = screen.getByRole("button", { name: "Refresh sessions" })

    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument()
    expect(toolbar).not.toBeNull()
    expect(Array.from(toolbar?.children ?? [])).toEqual([searchBox, archive, refresh])

    fireEvent.click(refresh)
    expect(props.onRefresh).toHaveBeenCalledOnce()
    expect(search).toHaveAttribute("placeholder", "Search sessions or PRs")
  })

  it("toggles archived sessions and reflects the pressed state", () => {
    const { props } = renderToolbar({ showArchived: true, archivedCount: 3 })

    const toggle = screen.getByRole("button", { name: "Hide archived sessions" })
    expect(toggle).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(toggle)
    expect(props.onToggleShowArchived).toHaveBeenCalledOnce()
  })
})

describe("LiveSessionsFeedback", () => {
  const base = {
    fetchError: null,
    showEmpty: true,
    searching: false,
    loading: false,
    sessionCount: 0,
    onRetry: vi.fn(),
  }

  it("explains an empty list when every session is archived and offers to show them", () => {
    const onShowArchived = vi.fn()
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={4} onShowArchived={onShowArchived} />)

    expect(screen.getByText("Everything is archived")).toBeInTheDocument()
    expect(screen.getByText("4 archived sessions are hidden.")).toBeInTheDocument()
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    expect(onShowArchived).toHaveBeenCalledOnce()
  })

  it("keeps the plain empty state when nothing is archived", () => {
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={0} onShowArchived={vi.fn()} />)

    expect(screen.getByText("No sessions yet")).toBeInTheDocument()
    expect(screen.queryByText("Everything is archived")).not.toBeInTheDocument()
  })

  it("does not blame archiving for an empty search", () => {
    render(<LiveSessionsFeedback {...base} searching hiddenArchivedCount={4} onShowArchived={vi.fn()} />)

    expect(screen.getByText("No matching sessions")).toBeInTheDocument()
  })
})
