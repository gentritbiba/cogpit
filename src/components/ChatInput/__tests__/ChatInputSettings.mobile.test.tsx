import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ChatInputSettings } from "../ChatInputSettings"
import { resetDynamicModelOptions } from "@/lib/utils"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetDynamicModelOptions()
})

describe("ChatInputSettings mobile", () => {
  it("opens a bottom sheet with the core controls and applies selections", async () => {
    const user = userEvent.setup()
    const onAgentKindChange = vi.fn()
    const onModelChange = vi.fn()
    const onEffortChange = vi.fn()
    const onFastModeEnabledChange = vi.fn()
    const onPermissionModeChange = vi.fn()

    render(
      <ChatInputSettings
        mobile
        agentKind="codex"
        onAgentKindChange={onAgentKindChange}
        selectedModel="gpt-5.6-sol"
        onModelChange={onModelChange}
        selectedEffort="medium"
        onEffortChange={onEffortChange}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
        isNewSession
        mobileExtra={<button type="button">Set goal</button>}
      />,
    )

    expect(screen.queryByRole("dialog", { name: "Session controls" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Session controls" }))

    const sheet = await screen.findByRole("dialog", { name: "Session controls" })
    expect(within(sheet).getByRole("heading", { name: "Model and behavior" })).toBeInTheDocument()
    expect(within(sheet).getByRole("heading", { name: "Long-running goal" })).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Set goal" })).toBeInTheDocument()

    const agentSelect = within(sheet).getByRole("combobox", { name: "Agent" })
    const modelSelect = within(sheet).getByRole("combobox", { name: "Model" })
    const effortSelect = within(sheet).getByRole("combobox", { name: "Reasoning effort" })
    const accessSelect = within(sheet).getByRole("combobox", { name: "Access policy" })

    fireEvent.change(agentSelect, { target: { value: "claude" } })
    fireEvent.change(modelSelect, { target: { value: "gpt-5.6-terra" } })
    fireEvent.change(effortSelect, { target: { value: "high" } })
    fireEvent.change(accessSelect, { target: { value: "plan" } })
    await user.click(within(sheet).getByRole("button", { name: "Standard" }))

    expect(onAgentKindChange).toHaveBeenCalledWith("claude")
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.6-terra")
    expect(onEffortChange).toHaveBeenCalledWith("high")
    expect(onPermissionModeChange).toHaveBeenCalledWith("plan")
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true)
  })

  it("keeps advanced worktree, Ultracode, and MCP actions available", async () => {
    const user = userEvent.setup()
    const onWorktreeEnabledChange = vi.fn()
    const onUltracodeEnabledChange = vi.fn()
    const onToggleMcpServer = vi.fn()
    const onRefreshMcpServers = vi.fn()
    const onMcpAuth = vi.fn()

    render(
      <ChatInputSettings
        mobile
        agentKind="claude"
        selectedModel="fable"
        onModelChange={vi.fn()}
        selectedEffort="high"
        onEffortChange={vi.fn()}
        isNewSession
        worktreeEnabled={false}
        onWorktreeEnabledChange={onWorktreeEnabledChange}
        ultracodeEnabled={false}
        onUltracodeEnabledChange={onUltracodeEnabledChange}
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

    await user.click(screen.getByRole("button", { name: "Session controls" }))
    const sheet = await screen.findByRole("dialog", { name: "Session controls" })

    await user.click(within(sheet).getByRole("button", { name: "Worktree" }))
    await user.click(within(sheet).getByRole("button", { name: "Ultracode" }))
    await user.click(within(sheet).getByRole("button", { name: /Refresh MCP status/i }))
    await user.click(within(sheet).getByRole("button", { name: /filesystem/i }))
    await user.click(within(sheet).getByRole("button", { name: /github/i }))

    expect(onWorktreeEnabledChange).toHaveBeenCalledWith(true)
    expect(onUltracodeEnabledChange).toHaveBeenCalledWith(true)
    expect(onRefreshMcpServers).toHaveBeenCalledOnce()
    expect(onToggleMcpServer).toHaveBeenCalledWith("filesystem")
    expect(onMcpAuth).toHaveBeenCalledWith("github")
  })

  it("closes the sheet and confirms before enabling full access", async () => {
    const user = userEvent.setup()
    const onPermissionModeChange = vi.fn()

    render(
      <ChatInputSettings
        mobile
        agentKind="codex"
        selectedModel="gpt-5.6-sol"
        onModelChange={vi.fn()}
        selectedEffort="medium"
        onEffortChange={vi.fn()}
        permissionMode="default"
        onPermissionModeChange={onPermissionModeChange}
        isNewSession
      />,
    )

    await user.click(screen.getByRole("button", { name: "Session controls" }))
    const sheet = await screen.findByRole("dialog", { name: "Session controls" })
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Access policy" }), {
      target: { value: "bypassPermissions" },
    })

    expect(onPermissionModeChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog", { name: "Session controls" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: /Enable full access/i })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Enable full access/i }))
    expect(onPermissionModeChange).toHaveBeenCalledWith("bypassPermissions")
  })
})
