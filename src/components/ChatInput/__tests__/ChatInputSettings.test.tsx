import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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

    fireEvent.click(screen.getByRole("button", { name: /Claude \/ Opus/i }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Codex$/ }))

    expect(onAgentKindChange).toHaveBeenCalledWith("codex")
  })

  it("shows codex defaults and selects codex models from the combined dropdown", () => {
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

    expect(screen.getByRole("button", { name: /^Opus$/ })).toBeInTheDocument()
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

    const trigger = screen.getByRole("button", { name: "Opus" })
    fireEvent.click(trigger)

    const selected = screen.getByRole("menuitemradio", { name: /Opus \(default\)/i })
    await vi.waitFor(() => expect(selected).toHaveFocus())

    fireEvent.keyDown(document, { key: "ArrowDown" })
    expect(screen.getByRole("menuitemradio", { name: /^Fable$/i })).toHaveFocus()

    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("closes a portaled dropdown when clicking outside it", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Opus" }))
    expect(screen.getByRole("menu", { name: "Model" })).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument()
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

    const trigger = screen.getByRole("button", { name: "MCPs 0/1" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: "Refresh MCP server status" }))
    expect(onRefreshMcpServers).toHaveBeenCalledOnce()
    expect(screen.getByRole("menu", { name: "MCP servers" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "filesystem" }))
    expect(onToggleMcpServer).toHaveBeenCalledWith("filesystem")

    fireEvent.click(screen.getByRole("menuitem", { name: /^githubNeeds auth$/i }))
    expect(onMcpAuth).toHaveBeenCalledWith("github")
    expect(screen.queryByRole("menu", { name: "MCP servers" })).not.toBeInTheDocument()
  })
})
