import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { UserDialogPrompt } from "../UserDialogPrompt"
import type { MissionControlUserDialog } from "../../../../shared/contracts/agentPrompts"

const REFUSAL: MissionControlUserDialog = {
  sessionId: "session-1",
  requestId: "dlg-1",
  dialogKind: "refusal_fallback_prompt",
  askedAt: 0,
  originalModel: "claude-opus-5",
  fallbackModel: "claude-opus-4-8",
  guidanceText: "Rephrasing may help.",
}

function renderPrompt(
  request: MissionControlUserDialog = REFUSAL,
  onChoose = vi.fn(),
) {
  render(<UserDialogPrompt request={request} responding={false} onChoose={onChoose} />)
  return onChoose
}

describe("UserDialogPrompt", () => {
  it("retries on the fallback model", async () => {
    const user = userEvent.setup()
    const onChoose = renderPrompt()

    await user.click(screen.getByRole("button", { name: /Retry on claude-opus-4-8/ }))

    expect(onChoose).toHaveBeenCalledWith("dlg-1", "retry_fallback")
  })

  it("lets the user go back and edit the prompt instead", async () => {
    const user = userEvent.setup()
    const onChoose = renderPrompt()

    await user.click(screen.getByRole("button", { name: "Edit prompt" }))

    expect(onChoose).toHaveBeenCalledWith("dlg-1", "edit_prompt")
  })

  it("dismissing answers cancelled so the CLI applies its default", async () => {
    const user = userEvent.setup()
    const onChoose = renderPrompt()

    await user.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(onChoose).toHaveBeenCalledWith("dlg-1", "cancelled")
  })

  it("shows the refusal guidance when the CLI sends one", () => {
    renderPrompt()
    expect(screen.getByText("Rephrasing may help.")).toBeInTheDocument()
  })

  it("renders without guidance text", () => {
    renderPrompt({ ...REFUSAL, guidanceText: undefined })
    expect(screen.getByRole("button", { name: "Edit prompt" })).toBeInTheDocument()
  })
})
