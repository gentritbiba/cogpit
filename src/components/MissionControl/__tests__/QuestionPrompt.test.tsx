import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QuestionPrompt } from "../QuestionPrompt"
import type { MissionControlQuestion } from "../../../../shared/contracts/missionControl"

function makeRequest(
  options: Array<{ label: string; description?: string }>,
  multiSelect = false,
): MissionControlQuestion {
  return {
    sessionId: "session-1",
    toolUseId: "tool-1",
    askedAt: 0,
    questions: [{
      question: "When you click the commit icon in the dock, what should happen?",
      header: "Commit",
      multiSelect,
      options: options.map((option) => ({ ...option, hasPreview: false })),
    }],
  }
}

function renderPrompt(request: MissionControlQuestion, onAnswer = vi.fn()) {
  render(
    <QuestionPrompt
      request={request}
      responding={false}
      gone={false}
      onAnswer={onAnswer}
      onOpenSession={vi.fn()}
    />,
  )
  return onAnswer
}

describe("QuestionPrompt", () => {
  it("answers with the clicked option when it carries a description", async () => {
    // The description puts the option inside a tooltip trigger. Selection has to
    // survive that wrapping — a tooltip that eats the click is worse than no
    // tooltip at all.
    const user = userEvent.setup()
    const onAnswer = renderPrompt(makeRequest([
      { label: "Send /commit to the agent", description: "Recommended." },
      { label: "Quick commit", description: "Uses a generated message." },
    ]))

    await user.click(screen.getByText("Quick commit"))

    expect(onAnswer).toHaveBeenCalledWith("tool-1", {
      "When you click the commit icon in the dock, what should happen?": "Quick commit",
    })
  })

  it("answers with the clicked option when it has no description", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPrompt(makeRequest([
      { label: "Full commit panel" },
      { label: "Drop commit" },
    ]))

    await user.click(screen.getByText("Drop commit"))

    expect(onAnswer).toHaveBeenCalledWith("tool-1", {
      "When you click the commit icon in the dock, what should happen?": "Drop commit",
    })
  })

  it("surfaces the description on hover", async () => {
    const user = userEvent.setup()
    renderPrompt(makeRequest([
      { label: "Send /commit to the agent", description: "Recommended — the agent stages and writes the message." },
    ]))

    await user.hover(screen.getByText("Send /commit to the agent"))

    expect(
      await screen.findByText("Recommended — the agent stages and writes the message."),
    ).toBeInTheDocument()
  })
})
