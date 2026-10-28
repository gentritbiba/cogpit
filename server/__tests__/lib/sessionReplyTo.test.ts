// @vitest-environment node
import { describe, expect, it } from "vitest"
import { replyTo } from "../../lib/sessionResult"
import type { Turn, TurnContentBlock } from "../../../shared/session/types"

const turn = (userMessage: string, contentBlocks: TurnContentBlock[]) => ({ userMessage, contentBlocks }) as unknown as Turn
const text = (value: string): TurnContentBlock => ({ kind: "text", text: [value] })
const steer = (content: string): TurnContentBlock => ({ kind: "queued_prompt", content })

describe("replyTo", () => {
  it("answers a message that started a turn with that turn's last text", () => {
    expect(replyTo([turn("HEAD-A hello", [text("working"), text("answer A")]), turn("other", [text("answer B")])], "HEAD-A")).toBe("answer A")
  })

  it("answers a steered message with what followed it, stopping at the next steer", () => {
    const turns = [turn("first", [text("early"), steer("HEAD-A ping"), text("answer A"), steer("someone else"), text("answer to them")])]
    expect(replyTo(turns, "HEAD-A")).toBe("answer A")
  })

  it("has no answer when nothing followed the message, or the message is not there", () => {
    expect(replyTo([turn("first", [text("early"), steer("HEAD-A ping"), steer("next")])], "HEAD-A")).toBeNull()
    expect(replyTo([turn("first", [text("x")])], "HEAD-A")).toBeNull()
  })
})
