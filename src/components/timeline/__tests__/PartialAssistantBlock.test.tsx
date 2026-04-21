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
      textBlocks: ["Hello, world"],
      thinkingBlocks: [],
    }
    render(<PartialAssistantBlock partial={partial} />)
    expect(screen.getByText("Hello, world")).toBeDefined()
  })

  it("renders thinking blocks above text blocks", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_2",
      textBlocks: ["Answer body"],
      thinkingBlocks: ["Reasoning step 1"],
    }
    render(<PartialAssistantBlock partial={partial} />)
    expect(screen.getByText("Reasoning step 1")).toBeDefined()
    expect(screen.getByText("Answer body")).toBeDefined()
  })

  it("returns null when the partial has no text or thinking content", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_empty",
      textBlocks: [],
      thinkingBlocks: [],
    }
    const { container } = render(<PartialAssistantBlock partial={partial} />)
    expect(container.firstChild).toBeNull()
  })

  it("tags the rendered element with the partial message id", () => {
    const partial: PartialRenderTurn = {
      messageId: "msg_tag",
      textBlocks: ["x"],
      thinkingBlocks: [],
    }
    const { container } = render(<PartialAssistantBlock partial={partial} />)
    const el = container.querySelector("[data-partial-message-id]")
    expect(el).not.toBeNull()
    expect(el!.getAttribute("data-partial-message-id")).toBe("msg_tag")
  })
})
