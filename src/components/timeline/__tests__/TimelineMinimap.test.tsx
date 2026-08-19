import { describe, it, expect, vi } from "vitest"
import { createRef } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineMinimap } from "../TimelineMinimap"
import type { Turn } from "@/lib/types"

function makeTurns(prompts: string[]): Turn[] {
  return prompts.map((p, i) => ({
    id: `turn-${i}`,
    userMessage: p,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }))
}

function renderRail(prompts: string[], onJump = vi.fn()) {
  const scrollRef = createRef<HTMLElement>()
  render(
    <TimelineMinimap
      turns={makeTurns(prompts)}
      scrollContainerRef={scrollRef}
      onJumpToTurn={onJump}
    />,
  )
  return onJump
}

describe("TimelineMinimap", () => {
  it("stays out of the way for a conversation you can already see", () => {
    renderRail(["one", "two"])

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument()
  })

  it("draws one tick per turn, labelled by its prompt", () => {
    renderRail(["fix the parser", "now ship it", "write the docs"])

    expect(screen.getByRole("navigation", { name: "Conversation timeline" })).toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(3)
    expect(screen.getByRole("button", { name: "Turn 2: now ship it" })).toBeInTheDocument()
  })

  it("keeps duplicate turn ids distinct while live turns settle", () => {
    const turns = makeTurns(["first", "streaming copy", "latest"])
    turns[1].id = turns[0].id
    const scrollRef = createRef<HTMLElement>()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    render(
      <TimelineMinimap
        turns={turns}
        scrollContainerRef={scrollRef}
        onJumpToTurn={vi.fn()}
      />,
    )

    expect(screen.getAllByRole("button")).toHaveLength(3)
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key")
    consoleError.mockRestore()
  })

  it("jumps to a turn when its tick is clicked", () => {
    const onJump = renderRail(["a", "b", "c"])

    fireEvent.click(screen.getByRole("button", { name: "Turn 3: c" }))

    expect(onJump).toHaveBeenCalledWith(2)
  })

  it("walks the rail with the arrow keys", () => {
    renderRail(["a", "b", "c"])
    const ticks = screen.getAllByRole("button")
    ticks[0].focus()

    fireEvent.keyDown(ticks[0], { key: "ArrowDown" })
    expect(document.activeElement).toBe(ticks[1])

    fireEvent.keyDown(ticks[1], { key: "ArrowUp" })
    expect(document.activeElement).toBe(ticks[0])
  })

  it("jumps to the ends of the conversation with Home and End", () => {
    renderRail(["a", "b", "c"])
    const ticks = screen.getAllByRole("button")
    ticks[1].focus()

    fireEvent.keyDown(ticks[1], { key: "End" })
    expect(document.activeElement).toBe(ticks[2])

    fireEvent.keyDown(ticks[2], { key: "Home" })
    expect(document.activeElement).toBe(ticks[0])
  })

  it("does not run past either end of the rail", () => {
    renderRail(["a", "b", "c"])
    const ticks = screen.getAllByRole("button")
    ticks[0].focus()

    fireEvent.keyDown(ticks[0], { key: "ArrowUp" })

    expect(document.activeElement).toBe(ticks[0])
  })
})
