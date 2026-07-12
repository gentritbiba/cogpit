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

  it("requires a separate confirmation dialog before enabling full access", () => {
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
    expect(onPermissionModeChange).not.toHaveBeenCalled()

    expect(screen.getByRole("dialog", { name: /Enable full access/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Enable full access/i }))
    expect(onPermissionModeChange).toHaveBeenCalledWith("bypassPermissions")
  })
})
