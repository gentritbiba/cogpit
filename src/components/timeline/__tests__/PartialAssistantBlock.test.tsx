import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { PartialAssistantBlock } from "../PartialAssistantBlock"
import type { PartialRenderTurn } from "@/lib/partialMessages"

afterEach(() => {
  cleanup()
})

describe("PartialAssistantBlock", () => {
  it("renders text blocks via AssistantText", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_1",
      blocks: [{ kind: "text", text: "Hello, world" }],
    }
    render(<PartialAssistantBlock partial={partial} />)
    expect(screen.getByText("Hello, world")).toBeDefined()
  })

  it("renders thinking and text blocks in the order provided", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_2",
      blocks: [
        { kind: "thinking", text: "Reasoning step 1" },
        { kind: "text", text: "Answer body" },
      ],
    }
    render(<PartialAssistantBlock partial={partial} />)
    expect(screen.getByText("Reasoning step 1")).toBeDefined()
    expect(screen.getByText("Answer body")).toBeDefined()
  })

  it("returns null when the partial has no blocks", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_empty",
      blocks: [],
    }
    const { container } = render(<PartialAssistantBlock partial={partial} />)
    expect(container.firstChild).toBeNull()
  })

  it("tags the rendered element with the partial message id", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_tag",
      blocks: [{ kind: "text", text: "x" }],
    }
    const { container } = render(<PartialAssistantBlock partial={partial} />)
    const el = container.querySelector("[data-partial-message-id]")
    expect(el).not.toBeNull()
    expect(el!.getAttribute("data-partial-message-id")).toBe("msg_tag")
  })
})
