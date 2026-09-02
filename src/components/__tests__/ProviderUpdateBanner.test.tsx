import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ProviderUpdateBanner } from "@/components/ProviderUpdateBanner"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { ALL_CAPABILITIES } from "../../../shared/contracts/team"
import { makeProviderUpdateInfo } from "@/__tests__/fixtures"
import type { ProviderUpdateInfo } from "@/lib/providerUpdates"

const mocks = vi.hoisted(() => ({ useProviderUpdates: vi.fn() }))
vi.mock("@/hooks/useProviderUpdates", () => ({ useProviderUpdates: mocks.useProviderUpdates }))

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

describe("ProviderUpdateBanner", () => {
  beforeEach(() => {
    __resetCapabilitiesForTest()
    mocks.useProviderUpdates.mockReset()
    mocks.useProviderUpdates.mockReturnValue(hookValue())
  })

  it("renders nothing when every CLI is current", () => {
    const { container } = render(<ProviderUpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a one-click update for a recognised install", async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [makeProviderUpdateInfo()], update }))

    render(<ProviderUpdateBanner />)
    expect(screen.getByText("Claude Code v2.1.19 → v2.1.20")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /update/i }))
    expect(update).toHaveBeenCalledWith("claude")
  })

  it("labels and updates GitHub Copilot CLI", async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const copilot = makeProviderUpdateInfo({
      provider: "copilot",
      displayName: "GitHub Copilot CLI",
      packageName: "@github/copilot",
      binaryPath: "/opt/homebrew/bin/copilot",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      installMethod: "homebrew",
      updateCommand: "brew upgrade --cask copilot-cli",
    })
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [copilot], update }))

    render(<ProviderUpdateBanner />)
    expect(screen.getByText("GitHub Copilot CLI v1.0.0 → v1.1.0")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^update$/i }))
    expect(update).toHaveBeenCalledWith("copilot")
  })

  it("shows the manual command when the install method is unknown", () => {
    mocks.useProviderUpdates.mockReturnValue(
      hookValue({
        pending: [makeProviderUpdateInfo({ installMethod: "unknown", updateCommand: null })],
      }),
    )

    render(<ProviderUpdateBanner />)
    expect(screen.queryByRole("button", { name: /^update$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/could not tell/i)).toBeInTheDocument()
  })

  it("hides the run button from members who cannot write config", () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: null,
      capabilities: { ...ALL_CAPABILITIES, configWrite: false },
    })
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending: [makeProviderUpdateInfo()] }))

    render(<ProviderUpdateBanner />)
    expect(screen.queryByRole("button", { name: /^update$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/npm install -g/)).toBeInTheDocument()
  })

  it("dismisses every pending offer at once", async () => {
    const dismiss = vi.fn()
    const pending = [makeProviderUpdateInfo(), makeProviderUpdateInfo({ provider: "codex", displayName: "Codex", latestVersion: "0.52.0" })]
    mocks.useProviderUpdates.mockReturnValue(hookValue({ pending, dismiss }))

    render(<ProviderUpdateBanner />)
    await userEvent.click(screen.getByRole("button", { name: /don't show again/i }))
    expect(dismiss).toHaveBeenCalledTimes(2)
  })

  it("confirms a successful update, then clears itself", () => {
    vi.useFakeTimers()
    const clearOutcome = vi.fn()
    mocks.useProviderUpdates.mockReturnValue(
      hookValue({
        outcome: {
          provider: "codex",
          status: "succeeded",
          message: "Codex updated to 0.149.0.",
          output: null,
        },
        clearOutcome,
      }),
    )

    render(<ProviderUpdateBanner />)
    expect(screen.getByText("Codex updated to 0.149.0.")).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(clearOutcome).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("reports a failed update instead of the offer", async () => {
    const clearOutcome = vi.fn()
    mocks.useProviderUpdates.mockReturnValue(
      hookValue({
        pending: [makeProviderUpdateInfo()],
        outcome: {
          provider: "claude",
          status: "failed",
          message: "`npm install -g …` exited with code 1.",
          output: "EACCES",
        },
        clearOutcome,
      }),
    )

    render(<ProviderUpdateBanner />)
    expect(screen.getByText("Update did not complete")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(clearOutcome).toHaveBeenCalled()
  })
})
