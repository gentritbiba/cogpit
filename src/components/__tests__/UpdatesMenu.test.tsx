import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { UpdatesMenu } from "@/components/UpdatesMenu"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"
import { makeProviderUpdateInfo } from "@/__tests__/fixtures"
import type { ProviderUpdateInfo } from "@/lib/providerUpdates"

const mocks = vi.hoisted(() => ({ useProviderUpdates: vi.fn(), toastSuccess: vi.fn() }))
vi.mock("@/hooks/useProviderUpdates", () => ({ useProviderUpdates: mocks.useProviderUpdates }))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))

const RELEASE = "https://github.com/gentritbiba/cogpit/releases/tag/v3.5.0"

function hookValue(overrides: Record<string, unknown> = {}) {
  return {
    pending: [] as ProviderUpdateInfo[],
    updating: null,
    outcome: null,
    update: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    clearOutcome: vi.fn(),
    ...overrides,
  }
}

function installApi(initial: ElectronUpdateState) {
  const api = {
    getState: vi.fn().mockResolvedValue(initial),
    onState: vi.fn(() => vi.fn()),
    install: vi.fn().mockResolvedValue(undefined),
  }
  window.electronUpdater = api
  return api
}

async function renderMenu(): Promise<ReturnType<typeof render>> {
  const view = render(<UpdatesMenu />)
  await act(async () => {})
  return view
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, label = "1 update"): Promise<void> {
  await user.click(screen.getByRole("button", { name: label }))
}

describe("UpdatesMenu", () => {
  beforeEach(() => {
    mocks.useProviderUpdates.mockReturnValue(hookValue())
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
    delete window.electronUpdater
  })

  it("renders nothing when every CLI is current and Cogpit has nothing waiting", async () => {
    const { container } = await renderMenu()
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a one-click update for a recognised CLI install", async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [makeProviderUpdateInfo()], update }))
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)
    expect(screen.getByText("Claude Code v2.1.19 → v2.1.20")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Update Claude Code" }))

    expect(update).toHaveBeenCalledWith("claude")
  })

  it("counts every pending update on the button", async () => {
    installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    mocks.useProviderUpdates.mockReturnValue(hookValue({
      pending: [makeProviderUpdateInfo(), makeProviderUpdateInfo({ provider: "codex", displayName: "Codex" })],
    }))
    await renderMenu()

    expect(screen.getByRole("button", { name: "3 updates" })).toBeInTheDocument()
  })

  it("says how to update a CLI whose install method is unknown", async () => {
    mocks.useProviderUpdates.mockReturnValue(hookValue({
      pending: [makeProviderUpdateInfo({ installMethod: "unknown", updateCommand: null })],
    }))
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)

    expect(screen.queryByRole("button", { name: "Update Claude Code" })).not.toBeInTheDocument()
    expect(screen.getByText(/could not tell/i)).toBeInTheDocument()
  })

  it("skips one CLI's version", async () => {
    const dismiss = vi.fn()
    const info = makeProviderUpdateInfo()
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [info], dismiss }))
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)
    await user.click(screen.getByRole("button", { name: "Skip this Claude Code version" }))

    expect(dismiss).toHaveBeenCalledWith(info)
  })

  it("stays hidden from members, who cannot update the host's CLIs", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: null,
      capabilities: { ...ALL_CAPABILITIES, configWrite: false },
    })
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [makeProviderUpdateInfo()] }))

    const { container } = await renderMenu()

    expect(container).toBeEmptyDOMElement()
  })

  it("reports a failed CLI update until dismissed", async () => {
    const clearOutcome = vi.fn()
    mocks.useProviderUpdates.mockReturnValue(hookValue({
      outcome: {
        provider: "claude",
        status: "failed",
        message: "`npm install -g …` exited with code 1.",
        output: "EACCES",
      },
      clearOutcome,
    }))
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)
    expect(screen.getByText("Update did not complete")).toBeInTheDocument()
    expect(screen.getByText("`npm install -g …` exited with code 1.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(clearOutcome).toHaveBeenCalled()
  })

  it("confirms a successful CLI update with a toast, then clears it", async () => {
    const clearOutcome = vi.fn()
    mocks.useProviderUpdates.mockReturnValue(hookValue({
      outcome: { provider: "codex", status: "succeeded", message: "Codex updated to 0.149.0.", output: null },
      clearOutcome,
    }))

    const { container } = await renderMenu()

    expect(mocks.toastSuccess).toHaveBeenCalledWith("Codex updated to 0.149.0.", expect.anything())
    expect(clearOutcome).toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it("restarts into a downloaded Cogpit update", async () => {
    const api = installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)
    expect(screen.getByText("Cogpit v3.5.0 is ready")).toBeInTheDocument()
    expect(screen.getByText(/installs the next time you quit/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /restart now/i }))

    expect(api.install).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: /restart now/i })).toBeDisabled()
  })

  it("warns that a package install asks for a password", async () => {
    installApi({ status: "ready", version: "3.5.0", asksForPassword: true })
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)

    expect(screen.getByText(/enter your password/)).toBeInTheDocument()
  })

  it("offers the release download when a Cogpit install fails", async () => {
    installApi({ status: "failed", version: "3.5.0", message: "pkexec was dismissed", url: RELEASE })
    const user = userEvent.setup()
    await renderMenu()

    await openMenu(user)

    expect(screen.getByText("Cogpit v3.5.0 could not be installed")).toBeInTheDocument()
    expect(screen.getByText("pkexec was dismissed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Download" })).toHaveAttribute("href", RELEASE)
  })

  it("leaves an available Cogpit release to the app menu", async () => {
    installApi({ status: "available", version: "3.5.0", url: RELEASE, via: "download" })

    const { container } = await renderMenu()

    expect(container).toBeEmptyDOMElement()
  })
})
