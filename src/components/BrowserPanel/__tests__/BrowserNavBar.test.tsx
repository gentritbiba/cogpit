import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BrowserNavBar, type BrowserPage } from "@/components/BrowserPanel/BrowserNavBar"
import type { BrowserTab } from "../../../../shared/browser/protocol"

function pageOf(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    type: "page",
    targetId: "tab-1",
    url: "https://example.test/one",
    title: "One",
    canGoBack: true,
    canGoForward: false,
    ...overrides,
  }
}

const TABS: BrowserTab[] = [
  { targetId: "tab-1", url: "https://example.test/one", title: "One" },
  { targetId: "tab-2", url: "https://other.test/two", title: "" },
]

type Props = ComponentProps<typeof BrowserNavBar>

function setup(props: Partial<Props> = {}) {
  const user = userEvent.setup()
  const handlers = {
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onFollow: vi.fn(),
  }
  const merged: Props = {
    page: pageOf(),
    tabs: [TABS[0]],
    followed: "tab-1",
    ...handlers,
    ...props,
  }
  const { rerender } = render(<BrowserNavBar {...merged} />)
  return {
    ...handlers,
    user,
    url: screen.getByRole("textbox", { name: "Page URL" }) as HTMLInputElement,
    rerender: (next: Partial<Props>) => rerender(<BrowserNavBar {...merged} {...next} />),
  }
}

describe("BrowserNavBar", () => {
  it("disables the history steps the page cannot take", async () => {
    const { user, onBack, onForward, onReload } = setup({
      page: pageOf({ canGoBack: false, canGoForward: true }),
    })

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Forward" }))
    expect(onForward).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "Reload" }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it("steps back when the page can", async () => {
    const { user, onBack } = setup()
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("navigates to what was typed on Enter", async () => {
    const { user, url, onNavigate } = setup()

    expect(url).toHaveValue("https://example.test/one")
    await user.clear(url)
    await user.type(url, "example.org/next{Enter}")

    expect(onNavigate).toHaveBeenCalledWith("example.org/next")
  })

  it("reverts an edit on Escape and on blur", async () => {
    const { user, url, onNavigate } = setup()

    await user.clear(url)
    await user.type(url, "typed{Escape}")
    expect(url).toHaveValue("https://example.test/one")

    await user.clear(url)
    await user.type(url, "typed again")
    fireEvent.blur(url)
    expect(url).toHaveValue("https://example.test/one")
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("does not overwrite an edit in progress when the page moves on", async () => {
    const { user, url, rerender } = setup()

    await user.clear(url)
    await user.type(url, "half-typed")
    rerender({ page: pageOf({ url: "https://example.test/two", title: "Two" }) })

    expect(url).toHaveValue("half-typed")
  })

  it("shows the live url again once the edit is committed", async () => {
    const { user, url, rerender } = setup()

    await user.clear(url)
    await user.type(url, "example.org{Enter}")
    rerender({ page: pageOf({ url: "https://example.org/" }) })

    expect(url).toHaveValue("https://example.org/")
  })

  it("hides the tab strip until a second tab exists", () => {
    setup()
    expect(screen.queryByRole("button", { name: /One/ })).not.toBeInTheDocument()
  })

  it("follows the tab that is clicked, labelling an untitled one by host", async () => {
    const { user, onFollow } = setup({ tabs: TABS })

    expect(screen.getByRole("button", { name: "One" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "other.test" }))

    expect(onFollow).toHaveBeenCalledWith("tab-2")
  })

  it("marks the stream live, still or cut off at the trailing end of the bar", () => {
    const { rerender } = setup({ status: "live" })

    expect(screen.getByText("LIVE")).toBeInTheDocument()

    rerender({ status: "idle" })
    expect(screen.getByText("IDLE")).toBeInTheDocument()
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument()

    rerender({ status: "offline" })
    expect(screen.getByText("OFFLINE")).toBeInTheDocument()
    expect(screen.queryByText("IDLE")).not.toBeInTheDocument()
  })

  it("says nothing about the stream when there is none to report", () => {
    setup()

    expect(screen.queryByText("LIVE")).not.toBeInTheDocument()
    expect(screen.queryByText("IDLE")).not.toBeInTheDocument()
  })

  it("keeps the stream status out of the tab strip", () => {
    setup({ status: "live", tabs: TABS })

    const tabStrip = screen.getByRole("button", { name: "One" }).parentElement
    expect(tabStrip?.textContent).not.toContain("LIVE")
    expect(screen.getByText("LIVE")).toBeInTheDocument()
  })

  it("opens the live url in the real browser", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const { user } = setup()

    await user.click(screen.getByRole("button", { name: "Open in your browser" }))

    expect(open).toHaveBeenCalledWith("https://example.test/one", "_blank", "noopener,noreferrer")
    open.mockRestore()
  })
})
