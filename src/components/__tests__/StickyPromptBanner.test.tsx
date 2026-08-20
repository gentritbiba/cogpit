import { useRef } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import { makeTurn } from "@/__tests__/fixtures"
import type { ParsedSession } from "@/lib/types"

function makeSession(
  sessionId: string,
  prompts: Array<string | null>,
): ParsedSession {
  return {
    sessionId,
    version: "1",
    gitBranch: "main",
    cwd: "/workspace",
    slug: "sticky-prompt-test",
    name: "",
    model: "claude-test",
    turns: prompts.map((userMessage, index) => makeTurn({
      id: `${sessionId}-turn-${index}`,
      userMessage,
    })),
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: prompts.length,
    },
    rawMessages: [],
  }
}

function Harness({ session }: { session: ParsedSession }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div>
      <StickyPromptBanner session={session} scrollContainerRef={scrollRef} />
      <div ref={scrollRef} data-testid="scroll-container">
        {session.turns.map((turn, index) => (
          <div key={turn.id} data-testid={`turn-${index}`} data-turn-index={index}>
            {turn.userMessage && (
              <div data-testid={`prompt-${index}`} data-turn-prompt>
                Prompt {index + 1}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function setRect(element: Element, top: number, bottom: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top,
    bottom,
    left: 0,
    right: 800,
    width: 800,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

describe("StickyPromptBanner", () => {
  let animationFrames: FrameRequestCallback[]

  beforeEach(() => {
    animationFrames = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function flushAnimationFrame(): void {
    const callbacks = animationFrames
    animationFrames = []
    act(() => {
      for (const callback of callbacks) callback(0)
    })
  }

  it("appears when the current prompt scrolls above the viewport", () => {
    render(<Harness session={makeSession("session-a", ["First prompt", "Fix the preview"])} />)

    const container = screen.getByTestId("scroll-container")
    const secondTurn = screen.getByTestId("turn-1")
    const secondPrompt = screen.getByTestId("prompt-1")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -400, -100)
    setRect(secondTurn, 60, 600)
    setRect(secondPrompt, 110, 170)

    flushAnimationFrame()
    expect(screen.queryByRole("button", { name: /scroll to turn 2 prompt/i })).not.toBeInTheDocument()

    setRect(secondTurn, -40, 500)
    setRect(secondPrompt, 20, 90)
    fireEvent.scroll(container)
    flushAnimationFrame()

    expect(screen.getByRole("button", { name: /scroll to turn 2 prompt/i })).toHaveTextContent(
      "Fix the preview",
    )
  })

  it("scrolls to the exact prompt instead of the start of a long turn", () => {
    render(<Harness session={makeSession("session-a", ["First prompt", "Second prompt"])} />)

    const container = screen.getByTestId("scroll-container")
    const prompt = screen.getByTestId("prompt-1")
    setRect(container, 100, 700)
    container.scrollTop = 500
    setRect(screen.getByTestId("turn-0"), -500, -200)
    setRect(screen.getByTestId("turn-1"), -100, 600)
    setRect(prompt, -60, 90)
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo

    flushAnimationFrame()
    fireEvent.click(screen.getByRole("button", { name: /scroll to turn 2 prompt/i }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 340, behavior: "smooth" })
  })

  it("falls back to the previous meaningful prompt for a promptless turn", () => {
    render(<Harness session={makeSession("session-a", ["Keep this context", null])} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -500, -200)
    setRect(screen.getByTestId("turn-1"), -100, 600)

    flushAnimationFrame()

    const banner = screen.getByRole("button", { name: /scroll to turn 1 prompt/i })
    expect(banner).toHaveTextContent("Keep this context")
  })
})
