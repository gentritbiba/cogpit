import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ fetchProviderUpdates: vi.fn() }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))

import { ChatInputSettings } from "../ChatInputSettings"
import { _resetAgentAvailabilityForTests } from "@/lib/agents/availability"

const missing = (provider: "codex" | "copilot" | "acp") =>
  makeProviderUpdateInfo({ provider, installed: false, binaryPath: null, status: "not-installed" })

beforeEach(() => _resetAgentAvailabilityForTests())
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function openPicker(agentKind: "claude" | "codex", mobile = false) {
  render(<ChatInputSettings mobile={mobile} agentKind={agentKind} onAgentKindChange={vi.fn()} selectedModel="" onModelChange={vi.fn()}
    selectedEffort="high" onEffortChange={vi.fn()} isNewSession />)
  if (mobile) {
    fireEvent.click(screen.getByRole("button", { name: "Session controls" }))
    return document.body
  }
  fireEvent.click(screen.getByRole("button", { name: agentKind === "claude" ? /^Claude/ : /^Codex/ }))
  return screen.getByRole("dialog", { name: "Model settings" })
}

describe("provider availability in the picker", () => {
  it("marks agents this computer does not have and hides an unconfigured ACP agent", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), missing("codex"), missing("copilot"), missing("acp")])
    const panel = openPicker("claude")

    await waitFor(() => expect(within(panel).getByRole("radio", { name: /Codex/ })).toHaveTextContent("Not installed"))
    expect(within(panel).getByRole("radio", { name: /Copilot/ })).toHaveTextContent("Not installed")
    expect(within(panel).getByRole("radio", { name: "Claude" })).not.toHaveTextContent("Not installed")
    expect(within(panel).queryByRole("radio", { name: /ACP/ })).not.toBeInTheDocument()
    expect(within(panel).queryByText("How to install")).not.toBeInTheDocument()
  })

  it("links the install page when the selected agent is missing", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), missing("codex")])
    const panel = openPicker("codex")
    await waitFor(() => expect(within(panel).getByText("How to install").closest("a"))
      .toHaveAttribute("href", "https://developers.openai.com/codex/cli"))
  })

  it("offers an ACP agent once the server can run it", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), makeProviderUpdateInfo({ provider: "acp", binaryPath: "/opt/acp" })])
    const panel = openPicker("claude")
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /ACP/ })).toBeInTheDocument())
  })

  it("says so in the phone's agent list too", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), missing("codex"), missing("acp")])
    openPicker("claude", true)
    await waitFor(() => expect(mocks.fetchProviderUpdates).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole("combobox", { name: "Agent" }))
    expect(await screen.findByRole("option", { name: "Codex (not installed)" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /ACP/ })).not.toBeInTheDocument()
  })
})
