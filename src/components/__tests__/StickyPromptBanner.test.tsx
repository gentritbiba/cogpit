import { useRef, useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import type { TimelineHandle } from "@/components/timeline/VirtualizedTimeline"
import { makeTurn } from "@/__tests__/fixtures"
import { formatCrewChatDelivery } from "../../../shared/contracts/crewChat"
import { renderComposerMessage } from "../../../shared/session/composerContext"
import type { ParsedSession, Turn } from "../../../shared/session/types"

function makeSession(sessionId: string, turns: Array<string | null | Partial<Turn>>): ParsedSession {
  return {
    sessionId,
    version: "1",
    gitBranch: "main",
    cwd: "/workspace",
    slug: "sticky-prompt-test",
    name: "",
    model: "claude-test",
    turns: turns.map((turn, index) => makeTurn({
      id: `${sessionId}-turn-${index}`,
      ...(typeof turn === "string" || turn === null ? { userMessage: turn } : turn),
    })),
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: turns.length,
    },
    rawMessages: [],
  }
}

const crewPost = (text: string) => formatCrewChatDelivery(
  { sequence: 3, id: "m3", rootId: "root", author: { kind: "agent", name: "ring-deploy" }, text, mentions: [], createdAt: 0 },
  true,
  "cogpit-session chat fetch 'root'",
  "cogpit-session chat post 'root' <text>",
)

/**
 * Stands in for the timeline: `bubbles[i]` lists the reader bubbles turn `i`
 * renders by `data-reader-prompt` key, and null leaves the turn unrendered, as
 * the virtualizer does far from the viewport.
 */
function Harness({
  session,
  bubbles,
  timeline,
}: {
  session: ParsedSession
  bubbles: Array<string[] | null>
  timeline?: TimelineHandle
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<TimelineHandle | null>(timeline ?? null)
  return (
    <div>
      <StickyPromptBanner session={session} scrollContainerRef={scrollRef} timelineRef={timelineRef} />
      <div ref={scrollRef} data-testid="scroll-container">
        {session.turns.map((turn, index) => bubbles[index] && (
          <div key={turn.id} data-testid={`turn-${index}`} data-turn-index={index}>
            {bubbles[index].map((key) => (
              <div key={key} data-testid={`bubble-${index}-${key}`} data-reader-prompt={key}>
                Message {index + 1}.{key}
              </div>
            ))}
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

const banner = (turn: number) => screen.getByRole("button", { name: `Scroll to your message in turn ${turn}` })

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

  it("appears when the reader's message scrolls above the viewport", () => {
    render(<Harness session={makeSession("session-a", ["First prompt", "Fix the preview"])} bubbles={[["prompt"], ["prompt"]]} />)

    const container = screen.getByTestId("scroll-container")
    const secondTurn = screen.getByTestId("turn-1")
    const secondPrompt = screen.getByTestId("bubble-1-prompt")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -400, -100)
    setRect(secondTurn, 60, 600)
    setRect(secondPrompt, 110, 170)

    flushAnimationFrame()
    expect(screen.queryByRole("button", { name: /scroll to your message/i })).not.toBeInTheDocument()

    setRect(secondTurn, -40, 500)
    setRect(secondPrompt, 20, 90)
    fireEvent.scroll(container)
    flushAnimationFrame()

    expect(banner(2)).toHaveTextContent("Fix the preview")
  })

  it("scrolls to the exact prompt instead of the start of a long turn", () => {
    render(<Harness session={makeSession("session-a", ["First prompt", "Second prompt"])} bubbles={[["prompt"], ["prompt"]]} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    container.scrollTop = 500
    setRect(screen.getByTestId("turn-0"), -500, -200)
    setRect(screen.getByTestId("turn-1"), -100, 600)
    setRect(screen.getByTestId("bubble-1-prompt"), -60, 90)
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo

    flushAnimationFrame()
    fireEvent.click(banner(2))

    expect(scrollTo).toHaveBeenCalledWith({ top: 340, behavior: "smooth" })
  })

  it("shows what the reader typed, not a task report quoted in the same prompt", () => {
    const quoted = "<task-notification><summary>Build completed</summary></task-notification>\nnow ship it"
    render(<Harness session={makeSession("session-a", ["First prompt", quoted])} bubbles={[["prompt"], ["prompt"]]} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -500, -200)
    setRect(screen.getByTestId("turn-1"), -100, 600)
    setRect(screen.getByTestId("bubble-1-prompt"), -60, 90)

    flushAnimationFrame()

    expect(banner(2)).toHaveTextContent("now ship it")
  })

  it("shows what the reader typed without the context the composer attached", () => {
    const composed = renderComposerMessage({
      text: "Apply this to the pricing page",
      context: [{ id: "ctx-quote0001", kind: "quote", text: "Use the queue", source: { dirName: "-repo", fileName: "s.jsonl", sessionId: "s", turnId: "t" } }],
    })
    render(<Harness session={makeSession("session-a", [composed])} bubbles={[["prompt"]]} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -500, 600)
    setRect(screen.getByTestId("bubble-0-prompt"), -480, -400)

    flushAnimationFrame()

    expect(banner(1)).toHaveTextContent("Apply this to the pricing page")
    expect(banner(1)).not.toHaveTextContent("context")
  })

  it("falls back to the previous meaningful prompt for a promptless turn", () => {
    render(<Harness session={makeSession("session-a", ["Keep this context", null])} bubbles={[["prompt"], []]} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -500, -200)
    setRect(screen.getByTestId("turn-1"), -100, 600)

    flushAnimationFrame()

    expect(banner(1)).toHaveTextContent("Keep this context")
  })

  it("passes over a crew chat post to the reader's own message, even while the post is in view", () => {
    render(
      <Harness
        session={makeSession("session-a", ["Ship the ring deploy", crewPost("@Lead thanks. One correction on (B)")])}
        bubbles={[["prompt"], []]}
      />,
    )

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    container.scrollTop = 800
    setRect(screen.getByTestId("turn-0"), -500, 60)
    setRect(screen.getByTestId("bubble-0-prompt"), -480, -420)
    setRect(screen.getByTestId("turn-1"), 80, 600)
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo

    flushAnimationFrame()

    expect(banner(1)).toHaveTextContent("Ship the ring deploy")
    expect(screen.queryByText(/crew chat/)).toBeNull()
    fireEvent.click(banner(1))
    expect(scrollTo).toHaveBeenCalledWith({ top: 220, behavior: "smooth" })
  })

  it("tracks a message the reader sent mid-turn", () => {
    const turn: Partial<Turn> = {
      userMessage: "Start the audit",
      contentBlocks: [
        { kind: "text", text: ["Working on it"] },
        { kind: "queued_prompt", content: "Also check mobile" },
        { kind: "queued_prompt", content: crewPost("Lane B is done") },
      ],
    }
    render(<Harness session={makeSession("session-a", [turn])} bubbles={[["prompt", "1"]]} />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    setRect(screen.getByTestId("turn-0"), -900, 600)
    setRect(screen.getByTestId("bubble-0-prompt"), -880, -820)
    setRect(screen.getByTestId("bubble-0-1"), -300, -250)

    flushAnimationFrame()

    expect(banner(1)).toHaveTextContent("Also check mobile")
  })

  it("reaches a message the timeline has not rendered, passing over what the crew sent after it", async () => {
    const earlier: Partial<Turn> = {
      userMessage: "Start the audit",
      contentBlocks: [{ kind: "queued_prompt", content: crewPost("Lane B is done") }],
    }
    const scrollToTurn = vi.fn<(index: number) => boolean>(() => true)

    function Virtualized() {
      const [mounted, setMounted] = useState(false)
      const session = makeSession("session-a", [earlier, crewPost("Lane C is done")])
      return (
        <Harness
          session={session}
          bubbles={[mounted ? ["prompt"] : null, []]}
          timeline={{
            scrollToTurn: (index) => {
              setMounted(true)
              return scrollToTurn(index)
            },
          }}
        />
      )
    }
    render(<Virtualized />)

    const container = screen.getByTestId("scroll-container")
    setRect(container, 100, 700)
    container.scrollTop = 5000
    setRect(screen.getByTestId("turn-1"), -100, 600)
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo

    flushAnimationFrame()
    fireEvent.click(banner(1))

    expect(scrollToTurn).toHaveBeenCalledWith(0)
    setRect(screen.getByTestId("bubble-0-prompt"), 150, 210)
    flushAnimationFrame()
    expect(scrollTo).not.toHaveBeenCalled()
    flushAnimationFrame()
    expect(scrollTo).toHaveBeenCalledWith({ top: 5050 })
  })
})
