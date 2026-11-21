import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AppMenu } from "@/components/AppMenu"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"
import { DOCUMENTATION_URL, REPORT_ISSUE_URL } from "../../../shared/helpLinks"

const mocks = vi.hoisted(() => ({
  networkUrl: null as string | null,
  canViewUsage: true,
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: { networkUrl: mocks.networkUrl } }),
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => mocks.canViewUsage }))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: mocks.copyToClipboard,
}))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock("@/components/PowerMonitor", () => ({
  PowerMonitor: ({ open }: { open: boolean }) => (open ? <div data-testid="power-monitor" /> : null),
}))
vi.mock("@/components/UsageCostDialog", () => ({
  UsageCostDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="usage-dialog" /> : null),
}))

const PROPS = {
  killing: false,
  onKillAll: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenCommandPalette: vi.fn(),
  onOpenKeyboardShortcuts: vi.fn(),
  onOpenPlugins: vi.fn(),
  onOpenAgentFiles: vi.fn(),
}

function Menu({ killing = false }: { killing?: boolean }) {
  const [monitorOpen, setMonitorOpen] = useState(false)
  return <AppMenu {...PROPS} killing={killing} monitorOpen={monitorOpen} onMonitorOpenChange={setMonitorOpen} />
}

type User = ReturnType<typeof userEvent.setup>

async function openMenu(user: User): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Settings and more" }))
  await screen.findByRole("menu")
}

async function choose(user: User, name: string | RegExp): Promise<void> {
  await openMenu(user)
  await user.click(screen.getByRole("menuitem", { name }))
}

describe("AppMenu", () => {
  beforeEach(() => {
    mocks.networkUrl = null
    mocks.canViewUsage = true
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
    delete window.electronUpdater
  })

  it("keeps the app's actions behind one closed button", () => {
    render(<Menu />)
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument()
  })

  it.each([
    ["Search and commands", PROPS.onOpenCommandPalette],
    ["Settings", PROPS.onOpenSettings],
    ["Plugins", PROPS.onOpenPlugins],
    ["Agent files", PROPS.onOpenAgentFiles],
    ["Keyboard shortcuts", PROPS.onOpenKeyboardShortcuts],
  ])("opens %s", async (name, handler) => {
    const user = userEvent.setup()
    render(<Menu />)
    await choose(user, new RegExp(`^${name}`))
    expect(handler).toHaveBeenCalledOnce()
  })

  it("keeps Plugins and Agent files from someone who may not change the host's config", async () => {
    setMe({ authenticated: true, edition: "team", user: null, capabilities: NO_CAPABILITIES })
    const user = userEvent.setup()
    render(<Menu />)

    await openMenu(user)

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Plugins" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Agent files" })).not.toBeInTheDocument()
  })

  it("opens usage and the server monitor", async () => {
    const user = userEvent.setup()
    render(<Menu />)

    await choose(user, "Usage & cost…")
    expect(screen.getByTestId("usage-dialog")).toBeInTheDocument()

    await choose(user, "Server monitor…")
    expect(screen.getByTestId("power-monitor")).toBeInTheDocument()
  })

  it("withholds usage from someone who may not view it", async () => {
    mocks.canViewUsage = false
    const user = userEvent.setup()
    render(<Menu />)

    await openMenu(user)

    expect(screen.queryByRole("menuitem", { name: "Usage & cost…" })).not.toBeInTheDocument()
  })

  it("renders no network readout while network access is off", async () => {
    const user = userEvent.setup()
    render(<Menu />)

    await openMenu(user)

    expect(screen.queryByRole("menuitem", { name: /Copy network URL/ })).not.toBeInTheDocument()
  })

  it("copies the connection URL while reachable on the network", async () => {
    mocks.networkUrl = "http://10.0.0.4:19384"
    mocks.copyToClipboard.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<Menu />)

    await choose(user, /10\.0\.0\.4/)

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("http://10.0.0.4:19384")
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied network URL"))
  })

  it("offers help and docs", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    try {
      const user = userEvent.setup()
      render(<Menu />)

      await openMenu(user)
      expect(screen.getByText("Help & docs")).toBeInTheDocument()
      await user.click(screen.getByRole("menuitem", { name: "Documentation" }))
      expect(open).toHaveBeenCalledWith(DOCUMENTATION_URL, "_blank", "noopener,noreferrer")

      await choose(user, "Report an issue")
      expect(open).toHaveBeenCalledWith(REPORT_ISSUE_URL, "_blank", "noopener,noreferrer")
    } finally {
      open.mockRestore()
    }
  })

  it("stops every agent process, and says so while it is", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Menu />)

    await choose(user, "Stop all agent processes")
    expect(PROPS.onKillAll).toHaveBeenCalledOnce()
    unmount()

    render(<Menu killing />)
    await openMenu(user)
    expect(screen.getByRole("menuitem", { name: "Stopping processes…" })).toHaveAttribute("aria-disabled", "true")
  })

  it("withholds stopping every process from someone who may not", async () => {
    setMe({ authenticated: true, edition: "team", user: null, capabilities: NO_CAPABILITIES })
    const user = userEvent.setup()
    render(<Menu />)

    await openMenu(user)

    expect(screen.queryByRole("menuitem", { name: "Stop all agent processes" })).not.toBeInTheDocument()
  })

  it("links an available Cogpit release's notes, quietly and only then", async () => {
    const url = "https://github.com/gentritbiba/cogpit/releases/tag/v3.7.0"
    window.electronUpdater = {
      getState: vi.fn().mockResolvedValue({ status: "available", version: "3.7.0", url, via: "download" }),
      onState: vi.fn(() => vi.fn()),
      install: vi.fn(),
    }
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    try {
      const user = userEvent.setup()
      render(<Menu />)
      await act(async () => {})

      expect(screen.queryByRole("button", { name: /update/i })).not.toBeInTheDocument()
      await choose(user, "Cogpit v3.7.0 release notes")
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer")
    } finally {
      open.mockRestore()
    }
  })

  it("has no release-notes item without an available release", async () => {
    window.electronUpdater = {
      getState: vi.fn().mockResolvedValue({ status: "ready", version: "3.7.0", asksForPassword: false }),
      onState: vi.fn(() => vi.fn()),
      install: vi.fn(),
    }
    const user = userEvent.setup()
    render(<Menu />)
    await act(async () => {})

    await openMenu(user)

    expect(screen.queryByRole("menuitem", { name: /release notes/ })).not.toBeInTheDocument()
  })
})
