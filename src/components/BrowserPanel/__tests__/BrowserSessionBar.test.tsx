import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BrowserSessionBar } from "@/components/BrowserPanel/BrowserSessionBar"
import type { BrowserActionResult } from "@/hooks/useBrowserSessions"
import type { BrowserSessionInfo } from "../../../../shared/browser/types"

function sessionOf(overrides: Partial<BrowserSessionInfo> = {}): BrowserSessionInfo {
  return {
    name: "default",
    isDefault: true,
    running: true,
    note: null,
    createdAt: null,
    lastUsedAt: null,
    lastUrl: null,
    driverSessionId: null,
    ...overrides,
  }
}

const WORK = sessionOf({
  name: "work",
  isDefault: false,
  running: false,
  lastUsedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
})

type Props = ComponentProps<typeof BrowserSessionBar>

function setup(props: Partial<Props> = {}) {
  const user = userEvent.setup()
  const handlers = {
    onSelect: vi.fn(),
    onToggleFollow: vi.fn(),
    onCreate: vi.fn<(name: string, note: string) => Promise<BrowserActionResult>>(
      async () => ({ ok: true }),
    ),
    onRemove: vi.fn(),
    onStop: vi.fn(),
    onShowDefault: vi.fn(),
    onClose: vi.fn(),
  }
  const { container } = render(
    <BrowserSessionBar
      sessions={[sessionOf(), WORK]}
      selected="default"
      currentSessionId="cogpit-1"
      followAgent
      {...handlers}
      {...props}
    />,
  )
  return { ...handlers, user, bar: container.firstElementChild as HTMLElement }
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Switch browser" }))
  return screen.findByRole("menuitemradio", { name: /^default/ })
}

describe("BrowserSessionBar", () => {
  it("stays plain on the default browser", () => {
    const { bar } = setup()

    expect(screen.queryByText("Not the default browser")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Show default" })).not.toBeInTheDocument()
    expect(bar).not.toHaveClass("bg-amber-500/10")
  })

  it("flags a non-default browser and offers the way back", async () => {
    const { bar, user, onShowDefault } = setup({ selected: "work" })

    expect(bar).toHaveClass("bg-amber-500/10", "border-amber-500/40")
    expect(screen.getByRole("status")).toHaveTextContent("Not the default browser")

    await user.click(screen.getByRole("button", { name: "Show default" }))
    expect(onShowDefault).toHaveBeenCalledTimes(1)
  })

  it("keeps the warning readable at the panel's own minimum width", () => {
    setup({ selected: "work" })
    const label = screen.getByText("Not the default browser")

    // The bar is narrower than @sm at the panel's 360px minimum, where the
    // label collapses to the icon beside it — but never out of the a11y tree.
    expect(label).toHaveClass("sr-only", "@sm/browser-bar:not-sr-only")
    expect(label).not.toHaveClass("hidden")
    expect(screen.getByRole("status").querySelector("svg")).toBeInTheDocument()
  })

  it("lists every browser and selects the one that is picked", async () => {
    const { user, onSelect } = setup()
    await openMenu(user)

    expect(screen.getByRole("menuitemradio", { name: /^default/ })).toBeInTheDocument()
    const work = screen.getByRole("menuitemradio", { name: /^work/ })
    expect(work).toHaveTextContent("2m ago")

    await user.click(work)
    expect(onSelect).toHaveBeenCalledWith("work")
  })

  it("says when another session drives a browser, and stays quiet about this one", async () => {
    const { user } = setup({
      sessions: [
        sessionOf({ driverSessionId: "cogpit-1" }),
        { ...WORK, driverSessionId: "cogpit-2" },
      ],
    })
    await openMenu(user)

    expect(screen.getByRole("menuitemradio", { name: /^default/ }))
      .not.toHaveTextContent("driven by another session")
    expect(screen.getByRole("menuitemradio", { name: /^work/ }))
      .toHaveTextContent("driven by another session")
  })

  it("refuses an invalid name inline without asking the server", async () => {
    const { user, onCreate } = setup()
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "New browser…" }))

    await user.type(await screen.findByLabelText("Name"), "Bad Name")

    expect(screen.getByRole("alert")).toHaveTextContent(/lowercase letters/i)
    const submit = screen.getByRole("button", { name: "Create browser" })
    expect(submit).toBeDisabled()

    await user.click(submit)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("shows a name the server rejects in the same place", async () => {
    const onCreate = vi.fn<(name: string, note: string) => Promise<BrowserActionResult>>(
      async () => ({ ok: false, error: "work already exists" }),
    )
    const { user, onSelect } = setup({ onCreate })
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "New browser…" }))

    await user.type(await screen.findByLabelText("Name"), "work")
    await user.type(screen.getByLabelText(/^Note/), "signed in as me")
    await user.click(screen.getByRole("button", { name: "Create browser" }))

    expect(onCreate).toHaveBeenCalledWith("work", "signed in as me")
    expect(await screen.findByRole("alert")).toHaveTextContent("work already exists")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("selects a browser it just created", async () => {
    const { user, onSelect } = setup()
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "New browser…" }))

    await user.type(await screen.findByLabelText("Name"), "shop")
    await user.click(screen.getByRole("button", { name: "Create browser" }))

    expect(onSelect).toHaveBeenCalledWith("shop")
  })

  it("never offers to delete the default browser", async () => {
    const { user } = setup()
    await openMenu(user)

    expect(screen.queryByRole("menuitem", { name: "Delete…" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Stop" })).not.toBeInTheDocument()
  })

  it("confirms before deleting a named browser", async () => {
    const { user, onRemove } = setup({ selected: "work" })
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }))

    expect(await screen.findByRole("heading", { name: "Delete work?" })).toBeInTheDocument()
    expect(screen.getByText(/signed out/i)).toBeInTheDocument()
    expect(onRemove).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Delete browser" }))
    expect(onRemove).toHaveBeenCalledWith("work")
  })

  it("stops the selected named browser", async () => {
    const { user, onStop } = setup({
      selected: "work",
      sessions: [sessionOf(), { ...WORK, running: true }],
    })
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Stop" }))

    expect(onStop).toHaveBeenCalledWith("work")
  })

  it("toggles following the agent and closes the panel", async () => {
    const { user, onToggleFollow, onClose } = setup()

    const follow = screen.getByRole("button", { name: "Follow agent" })
    expect(follow).toHaveAttribute("aria-pressed", "true")
    await user.click(follow)
    expect(onToggleFollow).toHaveBeenCalledWith(false)

    await user.click(screen.getByRole("button", { name: "Close browser panel" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
