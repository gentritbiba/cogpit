import { describe, it, expect } from "vitest"
import { parseAgentEnvelope, looksLikeQuestion } from "../../../shared/session/agentEnvelope"

describe("parseAgentEnvelope", () => {
  it("unwraps an <agent-message> envelope and returns the sender", () => {
    const r = parseAgentEnvelope(`<agent-message from="csp-and-proxy">\nbody text\n</agent-message>`)
    expect(r.sender).toBe("csp-and-proxy")
    expect(r.body).toBe("body text")
  })

  it("unwraps a <teammate-message> envelope via teammate_id", () => {
    const r = parseAgentEnvelope(`<teammate-message teammate_id="team-lead">hello</teammate-message>`)
    expect(r.sender).toBe("team-lead")
    expect(r.body).toBe("hello")
  })

  it("prefers the first envelope's sender when several are present", () => {
    const r = parseAgentEnvelope(
      `<agent-message from="a">one</agent-message>\n<agent-message from="b">two</agent-message>`,
    )
    expect(r.sender).toBe("a")
    expect(r.body).toBe("one\ntwo")
  })

  it("passes plain text through with a null sender", () => {
    const r = parseAgentEnvelope("just a prompt")
    expect(r.sender).toBeNull()
    expect(r.body).toBe("just a prompt")
  })

  it("leaves an unclosed tag alone rather than swallowing the rest", () => {
    const r = parseAgentEnvelope(`<agent-message from="x">no closing tag`)
    expect(r.sender).toBeNull()
    expect(r.body).toBe(`<agent-message from="x">no closing tag`)
  })
})

describe("looksLikeQuestion", () => {
  it("fires on an announced blocking question in the lead", () => {
    expect(looksLikeQuestion("payload-batch-2 - one blocking question on finding #1.\nDetail follows.")).toBe(true)
  })

  it("fires on a question mark near the end", () => {
    expect(looksLikeQuestion("I did the work. ".repeat(20) + "Should I also land the middleware hunk?")).toBe(true)
  })

  it("does not fire on a done report", () => {
    expect(looksLikeQuestion("payload-batch-2 done. bun run verify is PASS across all four gates.")).toBe(false)
  })

  it("does not fire on a question mark only in the opening paragraph", () => {
    expect(looksLikeQuestion("Remember the CSP question? I answered it myself. " + "Work log follows. ".repeat(30))).toBe(false)
  })

  it("returns false for empty input", () => {
    expect(looksLikeQuestion("   ")).toBe(false)
  })
})
