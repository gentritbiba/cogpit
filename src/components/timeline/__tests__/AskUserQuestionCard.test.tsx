import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolCall } from "../../../../shared/session/types"

const mocks = vi.hoisted(() => ({
  submitUserQuestionAnswers: vi.fn(async () => ({ ok: true, gone: false })),
  sendMessage: vi.fn(),
}))
vi.mock("@/lib/askUserApi", () => ({ submitUserQuestionAnswers: mocks.submitUserQuestionAnswers }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionChatContext: () => ({ chat: { sendMessage: mocks.sendMessage } }) }))

import { AskUserQuestionCard } from "../AskUserQuestionCard"

const QUESTIONS = [
  { question: "Pick a color?", header: "Color", options: [{ label: "Red", description: "Choose red" }, { label: "Blue", description: "Choose blue" }], multiSelect: false },
  { question: "Pick a size?", header: "Size", options: [{ label: "Small", description: "Choose small" }, { label: "Large", description: "Choose large" }], multiSelect: false },
]

function question(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "toolu_1", name: "AskUserQuestion", input: { questions: QUESTIONS }, result: null, isError: false, timestamp: "", ...overrides }
}

describe("AskUserQuestionCard", () => {
  it("reads a skipped question as skipped, not as an answer", () => {
    render(<AskUserQuestionCard
      toolCall={question({
        result: "The user answered: \"Pick a color?\"=\"The user skipped this question.\", \"Pick a size?\"=\"The user skipped this question.\".",
        unansweredQuestions: { "Pick a color?": "skipped", "Pick a size?": "skipped" },
      })}
      expandToolPayloads={false}
      canAnswer={false}
    />)
    expect(screen.getAllByText("Skipped")).toHaveLength(3)
    expect(screen.queryByText("The user skipped this question.")).not.toBeInTheDocument()
    expect(screen.queryByText("Answered")).not.toBeInTheDocument()
  })

  it("shows a chat reply as the user's words, marked as given in chat", () => {
    render(<AskUserQuestionCard
      toolCall={question({
        result: "The user answered: \"Pick a color?\"=\"Red\", \"Pick a size?\"=\"make it teal\".",
        unansweredQuestions: { "Pick a size?": "replied_in_chat" },
      })}
      expandToolPayloads={false}
      canAnswer={false}
    />)
    expect(screen.getByText("Answered")).toBeInTheDocument()
    expect(screen.getByText("Replied in chat")).toBeInTheDocument()
    expect(screen.getByText("make it teal")).toBeInTheDocument()
  })

  it("skips the waiting question for an agent that takes a skip", async () => {
    const user = userEvent.setup()
    render(<AskUserQuestionCard toolCall={question()} expandToolPayloads={false} isAwaitingAnswer sessionId="s1" canAnswer canSkip />)
    await user.click(screen.getByRole("button", { name: "Skip" }))
    await waitFor(() => expect(mocks.submitUserQuestionAnswers).toHaveBeenCalledWith("s1", "toolu_1", [], "skipped"))
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("offers no Skip for an agent that cannot take one", () => {
    render(<AskUserQuestionCard toolCall={question()} expandToolPayloads={false} isAwaitingAnswer sessionId="s1" canAnswer />)
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument()
  })
})
