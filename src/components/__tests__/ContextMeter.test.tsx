import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ContextMeter, sessionContextUsage } from "@/components/header-shared"
import type { RawMessage } from "../../../shared/session/types"
import { computeSessionDigest, type SessionView } from "../../../shared/session/sessionDigest"

function usage(inputTokens: number): RawMessage {
  return {
    type: "assistant",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 5_000,
      },
    },
  } as RawMessage
}

const reading = (inputTokens: number) => computeSessionDigest([usage(inputTokens)]).contextUsage

describe("ContextMeter", () => {
  it("renders nothing without token accounting", () => {
    const { container } = render(<ContextMeter usage={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the share of context left while there is plenty, without colour", () => {
    // opus-4-5 is a 200k model: 65k used of the 167k usable leaves 61%.
    render(<ContextMeter usage={reading(50_000)} />)

    const meter = screen.getByLabelText("61% of context left")
    expect(meter).toHaveTextContent("61%")
    expect(meter).toHaveClass("text-muted-foreground")
  })

  it("takes the warning colour once context runs low", () => {
    // 155k used of the 167k usable.
    render(<ContextMeter usage={reading(140_000)} />)

    const meter = screen.getByLabelText(/% of context left$/)
    expect(Number.parseInt(meter.textContent ?? "", 10)).toBeLessThan(30)
    expect(meter.className).toMatch(/text-(warning|destructive)/)
  })

  it("explains the reading on hover", async () => {
    const user = userEvent.setup()
    render(<ContextMeter usage={reading(50_000)} />)

    await user.hover(screen.getByLabelText("61% of context left"))

    expect(await screen.findByText("Context before auto-compact")).toBeInTheDocument()
    expect(screen.getByText(/tokens used/)).toBeInTheDocument()
  })
})

describe("sessionContextUsage", () => {
  const session = { digest: computeSessionDigest([usage(50_000)]) } as unknown as SessionView

  it("reads the usage of an agent whose records carry token accounting", () => {
    expect(sessionContextUsage(session, "-tmp-project")).toEqual(reading(50_000))
  })

  it("reads nothing for an agent whose records carry none", () => {
    expect(sessionContextUsage(session, "copilot__L3RtcC9wcm9qZWN0")).toBeNull()
  })
})
