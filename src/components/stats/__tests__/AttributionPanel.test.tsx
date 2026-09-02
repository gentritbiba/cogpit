import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { MessageAttribution, TokenUsage, Turn } from "../../../../shared/session/types"
import { AttributionPanel } from "../AttributionPanel"

let turnCounter = 0

function turn(attribution: MessageAttribution | undefined, usage: TokenUsage | null = null): Turn {
  turnCounter += 1
  return {
    id: `turn-${turnCounter}`,
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-08-25T00:00:00.000Z",
    durationMs: null,
    tokenUsage: usage,
    model: "claude-opus-5",
    attribution,
  }
}

describe("AttributionPanel", () => {
  it("renders nothing when no turn carries attribution", () => {
    const { container } = render(<AttributionPanel turns={[turn(undefined), turn(undefined)]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("breaks the most-used dimension down by turns and tokens", () => {
    render(
      <AttributionPanel
        turns={[
          turn({ skill: "commit" }, { input_tokens: 900, output_tokens: 100 }),
          turn({ skill: "commit" }, { input_tokens: 1_000, output_tokens: 0 }),
          turn({ skill: "agent-browser" }, { input_tokens: 40, output_tokens: 10 }),
        ]}
      />,
    )

    expect(screen.getByText("Attribution")).toBeInTheDocument()
    expect(screen.getByText("commit")).toBeInTheDocument()
    expect(screen.getByText("2 turns")).toBeInTheDocument()
    expect(screen.getByText("2.0k")).toBeInTheDocument()
    expect(screen.getByText("agent-browser")).toBeInTheDocument()
    expect(screen.getByText("1 turn")).toBeInTheDocument()
  })

  it("switches between the dimensions the transcript actually used", () => {
    render(
      <AttributionPanel
        turns={[
          turn({ agent: "Explore" }, { input_tokens: 10, output_tokens: 5 }),
          turn({ skill: "commit" }, { input_tokens: 10, output_tokens: 5 }),
        ]}
      />,
    )

    expect(screen.getByRole("button", { name: "Agents" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Skills" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "MCP tools" })).not.toBeInTheDocument()

    expect(screen.getByText("Explore")).toBeInTheDocument()
    expect(screen.queryByText("commit")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Skills" }))

    expect(screen.getByText("commit")).toBeInTheDocument()
    expect(screen.queryByText("Explore")).not.toBeInTheDocument()
  })

  it("shows unattributed turns as their own bucket so shares stay honest", () => {
    render(
      <AttributionPanel
        turns={[
          turn({ skill: "commit" }, { input_tokens: 10, output_tokens: 5 }),
          turn(undefined, { input_tokens: 5_000, output_tokens: 5_000 }),
        ]}
      />,
    )

    const rows = screen.getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("commit")
    expect(rows[1]).toHaveTextContent("Unattributed")
  })

  it("survives turns that recorded no token usage", () => {
    render(<AttributionPanel turns={[turn({ mcpServer: "clickup" })]} />)

    expect(screen.getByText("clickup")).toBeInTheDocument()
    expect(screen.getByText("0")).toBeInTheDocument()
  })
})
