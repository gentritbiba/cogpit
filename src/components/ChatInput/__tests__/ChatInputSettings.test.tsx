import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ChatInputSettings } from "../ChatInputSettings"
import { resetDynamicModelOptions, setDynamicModelOptions } from "@/lib/utils"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetDynamicModelOptions()
})

describe("ChatInputSettings", () => {
  it("lets new sessions switch agents from the model dropdown", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Claude \/ Default/i }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Codex$/ }))

    expect(onAgentKindChange).toHaveBeenCalledWith("codex")
  })

  it("shows codex defaults, selects a model, and closes the dropdown", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Codex \/ GPT-5\.6 Sol/i }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /GPT-5\.6 Terra/i }))

    expect(onModelChange).toHaveBeenCalledWith("gpt-5.6-terra")
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Agent and model" })).not.toBeInTheDocument()
    })
  })

  it("labels Default from the catalog's resolvedModel, never a hardcoded name", async () => {
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

    // The trigger shows what Default actually resolves to (the Sonnet row's label)
    fireEvent.click(screen.getByRole("button", { name: /Claude \/ Sonnet/ }))
    // The menu shows the CLI's own default row verbatim
    const defaultRow = await screen.findByRole("menuitemradio", { name: /Default \(recommended\)/ })
    expect(defaultRow).toHaveTextContent("Sonnet 5 · Org default")
    expect(screen.queryByRole("menuitemradio", { name: /Opus \(default\)/ })).not.toBeInTheDocument()
  })

  it("keeps the model-only dropdown for active sessions", () => {
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

    expect(screen.getByRole("button", { name: /^Default$/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Claude$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Codex$/ })).not.toBeInTheDocument()
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

    fireEvent.click(screen.getByRole("button", { name: "Ultracode" }))

    expect(onUltracodeEnabledChange).toHaveBeenCalledWith(true)
    await vi.waitFor(() => expect(onApplySettings).toHaveBeenCalled())
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

    expect(screen.getByRole("button", { name: "Extra High" })).toBeDisabled()
  })

  it("offers Fast only for models that advertise the tier", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Standard" }))
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
    expect(screen.queryByRole("button", { name: "Standard" })).not.toBeInTheDocument()
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

    fireEvent.click(screen.getByRole("button", { name: "Standard" }))
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto/ }))
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

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }))

    expect(screen.queryByRole("dialog", { name: /Enable full access/i })).not.toBeInTheDocument()
    expect(onPermissionModeChange).toHaveBeenCalledWith("bypassPermissions")
  })

  it("supports keyboard navigation and restores focus when a dropdown closes", async () => {
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

    const trigger = screen.getByRole("button", { name: "Default" })
    fireEvent.click(trigger)

    const selected = await screen.findByRole("menuitemradio", { name: /^Default$/i })
    await vi.waitFor(() => expect(selected).toHaveFocus())

    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("menuitemradio", { name: /^Fable$/i })).toHaveFocus()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })
  })

  it("closes a portaled dropdown when clicking outside it", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Default" }))
    expect(await screen.findByRole("menu", { name: "Model" })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument()
    })
  })

  it("preserves MCP toggle, refresh, and authentication interactions", async () => {
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

    const trigger = screen.getByRole("button", { name: "MCPs 0/1" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh status" }))
    expect(onRefreshMcpServers).toHaveBeenCalledOnce()
    expect(screen.getByRole("menu", { name: "MCP servers" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "filesystem" }))
    expect(onToggleMcpServer).toHaveBeenCalledWith("filesystem")

    fireEvent.click(screen.getByRole("menuitem", { name: /^githubNeeds auth$/i }))
    expect(onMcpAuth).toHaveBeenCalledWith("github")
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "MCP servers" })).not.toBeInTheDocument()
    })
  })
})
