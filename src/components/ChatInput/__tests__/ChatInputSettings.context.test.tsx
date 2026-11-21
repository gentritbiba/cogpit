import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { ChatInputSettings } from "../ChatInputSettings"
import { computeSessionDigest } from "../../../../shared/session/sessionDigest"
import type { RawMessage } from "../../../../shared/session/types"
import { showSession } from "@/__tests__/sessionContextMock"

vi.mock("@/contexts/SessionContext", async () => (await import("@/__tests__/sessionContextMock")).withSessionHooks({
  useSessionContextOptional: () => ({ sessionSource: { dirName: "-tmp-project", fileName: "s.jsonl" } }),
}))

function renderSettings() {
  return render(
    <ChatInputSettings
      selectedModel=""
      onModelChange={vi.fn()}
      selectedEffort="high"
      onEffortChange={vi.fn()}
      permissionMode="default"
      onPermissionModeChange={vi.fn()}
      isNewSession={false}
    />,
  )
}

describe("ChatInputSettings context meter", () => {
  afterEach(() => {
    cleanup()
  })

  it("keeps the context left in view beside the model picker", () => {
    // opus-4-5 is a 200k model: 65k used of the 167k usable leaves 61%.
    showSession({
      sessionId: "s",
      turns: [],
      digest: computeSessionDigest([{
        type: "assistant",
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 50_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      } as RawMessage]),
    })
    renderSettings()

    const meter = screen.getByLabelText("61% of context left")
    const group = screen.getByRole("group", { name: "Session settings" })
    expect(group).toContainElement(meter)
    // After the chips row, so it sits with the model rather than the session controls.
    expect(group.firstElementChild).not.toContainElement(meter)
  })

  it("shows no meter before there is a session", () => {
    renderSettings()

    expect(screen.queryByLabelText(/of context left$/)).not.toBeInTheDocument()
  })
})
