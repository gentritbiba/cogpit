import { describe, it, expect } from "vitest"
import { parseTeammateMessage } from "@/lib/teammateMessage"

describe("parseTeammateMessage", () => {
  it("extracts teammate_id and unwraps the inner body", () => {
    const input = `<teammate-message teammate_id="team-lead"> Explore the repo and report back. </teammate-message>`
    const result = parseTeammateMessage(input)
    expect(result.isTeammate).toBe(true)
    expect(result.teammateId).toBe("team-lead")
    expect(result.text).toBe("Explore the repo and report back.")
  })

  it("preserves multiline markdown inside the envelope", () => {
    const input = `<teammate-message teammate_id="cc-research">Report:\n1. First\n2. Second</teammate-message>`
    const result = parseTeammateMessage(input)
    expect(result.text).toBe("Report:\n1. First\n2. Second")
    expect(result.teammateId).toBe("cc-research")
  })

  it("handles an envelope with no teammate_id attribute", () => {
    const input = `<teammate-message>hello there</teammate-message>`
    const result = parseTeammateMessage(input)
    expect(result.isTeammate).toBe(true)
    expect(result.teammateId).toBeNull()
    expect(result.text).toBe("hello there")
  })

  it("still reads teammate_id when other attributes precede it", () => {
    const input = `<teammate-message from="x" teammate_id="team-lead" seq="3">body</teammate-message>`
    const result = parseTeammateMessage(input)
    expect(result.teammateId).toBe("team-lead")
    expect(result.text).toBe("body")
  })

  it("passes plain text through unchanged", () => {
    const input = "just a normal user message"
    const result = parseTeammateMessage(input)
    expect(result.isTeammate).toBe(false)
    expect(result.teammateId).toBeNull()
    expect(result.text).toBe(input)
  })

  it("unwraps multiple envelopes and keeps the first id", () => {
    const input = `<teammate-message teammate_id="a">one</teammate-message>\n<teammate-message teammate_id="b">two</teammate-message>`
    const result = parseTeammateMessage(input)
    expect(result.teammateId).toBe("a")
    expect(result.isTeammate).toBe(true)
    expect(result.text).toBe("one\ntwo")
  })
})
