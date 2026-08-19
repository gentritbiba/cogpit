import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { makeEditToolCall, makeTurn } from "@/__tests__/fixtures"
import { TurnChangedFiles } from "../TurnChangedFiles"
import { OPEN_SUBAGENT_EVENT } from "@/components/FileChangesPanel/file-change-indicators"

describe("TurnChangedFiles", () => {
  it("starts as a compact collapsed summary and reveals the tree on click", () => {
    const turn = makeTurn({
      toolCalls: [
        makeEditToolCall(
          "/project/src/App.tsx",
          "const oldValue = true",
          "const newValue = false\nconst secondValue = true",
        ),
      ],
    })

    const { container } = render(
      <TurnChangedFiles turn={turn} turnIndex={0} cwd="/project" />,
    )

    const trigger = screen.getByRole("button", { name: /1 file/i })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("src")).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="collapsible-content"]')).toBeNull()
    expect(screen.queryByText("changed")).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("src")).toBeVisible()
    expect(container.querySelector('[data-slot="collapsible-content"]')).toBeInTheDocument()
  })

  it("keeps file and sub-agent actions as separate keyboard controls", () => {
    const subAgentEdit = makeEditToolCall("/project/App.tsx", "old", "new")
    const turn = makeTurn({
      subAgentActivity: [{
        agentId: "agent-1",
        agentName: "Worker",
        subagentType: "general-purpose",
        type: "assistant",
        content: [],
        toolCalls: [subAgentEdit],
        thinking: [],
        text: [],
        timestamp: "2025-01-15T10:00:00Z",
        tokenUsage: null,
        model: null,
        isBackground: false,
      }],
    })
    const onOpenAgent = vi.fn()
    window.addEventListener(OPEN_SUBAGENT_EVENT, onOpenAgent)

    const { container } = render(
      <TurnChangedFiles turn={turn} turnIndex={0} cwd="/project" />,
    )
    fireEvent.click(screen.getByRole("button", { name: /1 file/i }))

    expect(container.querySelector("button button")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Open sub-agent view" }))
    expect(onOpenAgent).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_SUBAGENT_EVENT, onOpenAgent)
  })
})
