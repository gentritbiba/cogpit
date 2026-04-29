import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ChatInputSettings } from "../ChatInputSettings"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
    fireEvent.click(screen.getByRole("button", { name: /^Codex$/ }))

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

    fireEvent.click(screen.getByRole("button", { name: /Codex \/ GPT-5\.4/i }))
    fireEvent.click(screen.getByRole("button", { name: /GPT-5\.4 Mini/i }))

    expect(onModelChange).toHaveBeenCalledWith("gpt-5.4-mini")
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
})
