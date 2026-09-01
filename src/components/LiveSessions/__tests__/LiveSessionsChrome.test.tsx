import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LiveSessionsToolbar } from "../LiveSessionsChrome"

describe("LiveSessionsToolbar", () => {
  it("places refresh after the search box without a sessions heading", () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <LiveSessionsToolbar
        loading={false}
        isMobile={false}
        searchQuery=""
        searchLoading={false}
        onSearchQueryChange={vi.fn()}
        onRefresh={onRefresh}
      />,
    )

    const toolbar = container.firstElementChild
    const search = screen.getByRole("searchbox")
    const searchBox = search.closest('[data-slot="input-group"]')
    const refresh = screen.getByRole("button", { name: "Refresh sessions" })

    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument()
    expect(toolbar).not.toBeNull()
    expect(Array.from(toolbar?.children ?? [])).toEqual([searchBox, refresh])

    fireEvent.click(refresh)
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(search).toHaveAttribute("placeholder", "Search sessions or PRs")
  })
})
