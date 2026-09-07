import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ChatInputSettings } from "../ChatInputSettings"
import { resetDynamicModelOptions, setDynamicModelOptions } from "@/lib/utils"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetDynamicModelOptions()
})

function openModelPicker(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }))
  return screen.getByRole("dialog", { name: "Model settings" })
}

describe("ChatInputSettings", () => {
  it("lets new sessions switch provider inside the picker without closing it", () => {
    const onAgentKindChange = vi.fn()

    render(
      <ChatInputSettings
        agentKind="claude"
        onAgentKindChange={onAgentKindChange}
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
      />
    )

    const panel = openModelPicker(/^Claude · Default · High$/)
    expect(within(panel).getByRole("radio", { name: "Claude" })).toBeChecked()
    expect(within(panel).getByRole("radio", { name: "Copilot" })).toBeEnabled()
    fireEvent.click(within(panel).getByRole("radio", { name: "Codex" }))

    expect(onAgentKindChange).toHaveBeenCalledWith("codex")
    expect(screen.getByRole("dialog", { name: "Model settings" })).toBeInTheDocument()
  })

  it("opens downward for new sessions and upward for live ones", async () => {
    const { unmount } = render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
      />
    )
    await waitFor(() => expect(openModelPicker(/Default/)).toHaveAttribute("data-side", "bottom"))
    unmount()

    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession={false}
      />
    )
    await waitFor(() => expect(openModelPicker(/Default/)).toHaveAttribute("data-side", "top"))
  })

  it("shows Copilot models from its live catalog", () => {
    setDynamicModelOptions("copilot", [
      { value: "", label: "Default", resolvedModel: "gpt-5.4", isDefault: true },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    ])

    render(
      <ChatInputSettings
        agentKind="copilot"
        onAgentKindChange={vi.fn()}
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        activeModelId="gpt-5.4"
        isNewSession
      />
    )

    const panel = openModelPicker(/^Copilot · GPT-5\.4$/)
    expect(within(panel).getByRole("radio", { name: /^Claude Sonnet 4\.6/ })).toBeInTheDocument()
    expect(within(panel).getByRole("radio", { name: /^Gemini 3\.1 Pro Preview/ })).toBeInTheDocument()
    // Copilot has no effort ladder and no modes, so neither section renders.
    expect(within(panel).queryByText("Reasoning effort")).not.toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "Ultracode" })).not.toBeInTheDocument()
  })

  it("offers only Ask, Plan, Autopilot and Full access for Copilot and closes on choice", async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <ChatInputSettings
        agentKind="copilot"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
        isNewSession
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Permissions: Ask" }))
    const panel = screen.getByRole("dialog", { name: "Permissions" })
    expect(within(panel).getByRole("radio", { name: /^Ask/ })).toBeChecked()
    expect(within(panel).getByRole("radio", { name: /^Plan/ })).toBeInTheDocument()
    expect(within(panel).getByRole("radio", { name: /^Autopilot/ })).toBeInTheDocument()
    expect(within(panel).getByRole("radio", { name: /^Full access/ })).toBeInTheDocument()
    expect(within(panel).queryByRole("radio", { name: /^Accept Edits/ })).not.toBeInTheDocument()

    fireEvent.click(within(panel).getByRole("radio", { name: /^Plan/ }))
    expect(onPermissionModeChange).toHaveBeenCalledWith("plan")
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Permissions" })).not.toBeInTheDocument()
    })
  })

  it("selects a codex model and keeps the picker open", () => {
    const onModelChange = vi.fn()

    render(
      <ChatInputSettings
        agentKind="codex"
        onAgentKindChange={vi.fn()}
        selectedModel=""
        onModelChange={onModelChange}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
      />
    )

    const panel = openModelPicker(/^Codex · GPT-5\.6 Sol · High$/)
    fireEvent.click(within(panel).getByRole("radio", { name: /GPT-5\.6 Terra/i }))

    expect(onModelChange).toHaveBeenCalledWith("gpt-5.6-terra")
    expect(screen.getByRole("dialog", { name: "Model settings" })).toBeInTheDocument()
  })

  it("labels Default from the catalog's resolvedModel, never a hardcoded name", () => {
    // Regression: an org default of Sonnet used to render as "Opus (default)".
    setDynamicModelOptions("claude", [
      {
        value: "",
        label: "Default (recommended)",
        description: "Sonnet 5 · Org default",
        resolvedModel: "claude-sonnet-5",
        isDefault: true,
      },
      { value: "sonnet", label: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", resolvedModel: "claude-sonnet-5" },
      { value: "opus[1m]", label: "Opus (1M context)", resolvedModel: "claude-opus-5[1m]" },
    ])

    render(
      <ChatInputSettings
        agentKind="claude"
        onAgentKindChange={vi.fn()}
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
      />
    )

    // The chip shows what Default actually resolves to (the Sonnet row's label)
    const panel = openModelPicker(/^Claude · Sonnet · High$/)
    // The list shows the CLI's own default row verbatim
    const defaultRow = within(panel).getByRole("radio", { name: /Default \(recommended\)/ })
    expect(defaultRow).toHaveTextContent("Sonnet 5 · Org default")
    expect(within(panel).queryByRole("radio", { name: /Opus \(default\)/ })).not.toBeInTheDocument()
  })

  it("locks the provider column for active sessions", () => {
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession={false}
      />
    )

    const panel = openModelPicker(/^Claude · Default · High$/)
    expect(within(panel).getByRole("radio", { name: "Claude" })).toBeChecked()
    expect(within(panel).getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-disabled", "true")
    expect(within(panel).getByRole("radio", { name: "Copilot" })).toHaveAttribute("aria-disabled", "true")
    expect(within(panel).getByText(/Fixed for this session/)).toBeInTheDocument()
  })

  it("offers Ultracode for capable active Claude sessions and applies the toggle", async () => {
    const onUltracodeEnabledChange = vi.fn()
    const onApplySettings = vi.fn().mockResolvedValue(undefined)

    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel="fable"
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        ultracodeEnabled={false}
        onUltracodeEnabledChange={onUltracodeEnabledChange}
        onApplySettings={onApplySettings}
        isNewSession={false}
      />,
    )

    const panel = openModelPicker(/^Claude · Fable · High$/)
    fireEvent.click(within(panel).getByRole("button", { name: "Ultracode" }))

    expect(onUltracodeEnabledChange).toHaveBeenCalledWith(true)
    await vi.waitFor(() => expect(onApplySettings).toHaveBeenCalled())
  })

  it("greys Ultracode out when the selected model cannot run it", () => {
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel="haiku"
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
      />,
    )

    const panel = openModelPicker(/^Claude · Haiku · High$/)
    expect(within(panel).getByRole("button", { name: "Ultracode" })).toBeDisabled()
  })

  it("pins the effort selector while Ultracode is enabled", () => {
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel="fable"
        onModelChange={vi.fn()}
        selectedEffort="xhigh"
        onEffortChange={vi.fn()}
        ultracodeEnabled
        onUltracodeEnabledChange={vi.fn()}
        isNewSession={false}
      />,
    )

    const panel = openModelPicker(/Ultracode on/)
    expect(within(panel).getByRole("button", { name: "Ultracode" })).toHaveAttribute("aria-pressed", "true")
    expect(within(panel).getByRole("button", { name: "Extra High" })).toBeDisabled()
    expect(within(panel).getByRole("button", { name: "Light" })).toBeDisabled()
    expect(within(panel).getByText("Pinned by Ultracode")).toBeInTheDocument()
  })

  it("changes effort from the segmented control and keeps the picker open", () => {
    const onEffortChange = vi.fn()
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={onEffortChange}
        isNewSession
      />,
    )

    const panel = openModelPicker(/Default/)
    expect(within(panel).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(within(panel).getByRole("button", { name: "Max" }))
    expect(onEffortChange).toHaveBeenCalledWith("max")
    expect(screen.getByRole("dialog", { name: "Model settings" })).toBeInTheDocument()
  })

  it("enables Fast only for models that advertise the tier", () => {
    const onFastModeEnabledChange = vi.fn()
    const { rerender } = render(
      <ChatInputSettings
        agentKind="codex"
        selectedModel="gpt-5.6-sol"
        onModelChange={vi.fn()}
        selectedEffort="medium"
        onEffortChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
        isNewSession
      />
    )

    let panel = openModelPicker(/GPT-5\.6 Sol/)
    fireEvent.click(within(panel).getByRole("button", { name: "Fast mode" }))
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true)

    rerender(
      <ChatInputSettings
        agentKind="codex"
        selectedModel="gpt-5.3-codex-spark"
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
        isNewSession
      />
    )
    panel = screen.getByRole("dialog", { name: "Model settings" })
    expect(within(panel).getByRole("button", { name: "Fast mode" })).toBeDisabled()
  })

  it("shows Fast and Ultracode on the chip once they are on", () => {
    setDynamicModelOptions("claude", [
      { value: "", label: "Default" },
      { value: "opus", label: "Opus", serviceTiers: [{ value: "fast", label: "Fast" }] },
    ])
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel="opus"
        onModelChange={vi.fn()}
        selectedEffort="xhigh"
        onEffortChange={vi.fn()}
        fastModeEnabled
        onFastModeEnabledChange={vi.fn()}
        ultracodeEnabled
        onUltracodeEnabledChange={vi.fn()}
        isNewSession
      />
    )

    expect(screen.getByRole("button", {
      name: "Claude · Opus · Extra High (Fast mode on, Ultracode on)",
    })).toBeInTheDocument()
  })

  it("uses Claude's live Fast, effort, and Auto capabilities", () => {
    setDynamicModelOptions("claude", [
      { value: "", label: "Default" },
      {
        value: "opus",
        label: "Opus",
        supportsEffort: true,
        supportedReasoningEfforts: [{ value: "low", label: "Light" }, { value: "max", label: "Max" }],
        supportsAutoMode: true,
        serviceTiers: [{ value: "fast", label: "Fast" }],
      },
    ])
    const onFastModeEnabledChange = vi.fn()
    const onPermissionModeChange = vi.fn()
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel="opus"
        onModelChange={vi.fn()}
        selectedEffort="low"
        onEffortChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
        isNewSession
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
      />,
    )

    const panel = openModelPicker(/^Claude · Opus · Light$/)
    fireEvent.click(within(panel).getByRole("button", { name: "Fast mode" }))
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true)
    expect(within(panel).getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true")
    expect(within(panel).getByRole("button", { name: "Max" })).toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "High" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Permissions: Ask" }))
    fireEvent.click(screen.getByRole("radio", { name: /^Auto/ }))
    expect(onPermissionModeChange).toHaveBeenCalledWith("auto")
  })

  it("enables full access directly without a confirmation dialog", () => {
    const onPermissionModeChange = vi.fn()
    render(
      <ChatInputSettings
        agentKind="codex"
        selectedModel="gpt-5.6-sol"
        onModelChange={vi.fn()}
        selectedEffort="medium"
        onEffortChange={vi.fn()}
        isNewSession
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Permissions: Workspace" }))
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }))

    expect(screen.queryByRole("dialog", { name: /Enable full access/i })).not.toBeInTheDocument()
    expect(onPermissionModeChange).toHaveBeenCalledWith("bypassPermissions")
  })

  it("closes on Escape and restores focus to the chip", async () => {
    const user = userEvent.setup()
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession={false}
      />,
    )

    const trigger = screen.getByRole("button", { name: /^Claude · Default · High$/ })
    fireEvent.click(trigger)
    expect(await screen.findByRole("dialog", { name: "Model settings" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Model settings" })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })

  it("closes a portaled picker when clicking outside it", async () => {
    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession={false}
      />,
    )

    openModelPicker(/Default/)
    expect(await screen.findByRole("dialog", { name: "Model settings" })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    fireEvent.mouseDown(document.body)
    fireEvent.click(document.body)
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Model settings" })).not.toBeInTheDocument()
    })
  })

  it("preserves MCP toggle, refresh, and authentication interactions", () => {
    const onToggleMcpServer = vi.fn()
    const onRefreshMcpServers = vi.fn()
    const onMcpAuth = vi.fn()

    render(
      <ChatInputSettings
        agentKind="claude"
        selectedModel=""
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
        mcpServers={[
          { name: "filesystem", status: "connected" },
          { name: "github", status: "needs_auth" },
        ]}
        selectedMcpServers={[]}
        onToggleMcpServer={onToggleMcpServer}
        onRefreshMcpServers={onRefreshMcpServers}
        onMcpAuth={onMcpAuth}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "MCPs 0/1" }))
    const panel = screen.getByRole("dialog", { name: "MCP servers" })
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh status" }))
    expect(onRefreshMcpServers).toHaveBeenCalledOnce()

    fireEvent.click(within(panel).getByRole("checkbox", { name: "filesystem" }))
    expect(onToggleMcpServer).toHaveBeenCalledWith("filesystem")
    // Multi-select: the panel stays open between toggles.
    expect(screen.getByRole("dialog", { name: "MCP servers" })).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole("button", { name: /^github/ }))
    expect(onMcpAuth).toHaveBeenCalledWith("github")
  })
})
