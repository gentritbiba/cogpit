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

describe("parseAgentEnvelope attributes", () => {
  it("prefers teammate_id over an earlier from attribute", () => {
    const r = parseAgentEnvelope(`<teammate-message from="x" teammate_id="team-lead" seq="3">body</teammate-message>`)
    expect(r.sender).toBe("team-lead")
    expect(r.body).toBe("body")
  })

  it("reads a single-quoted attribute value", () => {
    const r = parseAgentEnvelope(`<agent-message from='csp-and-proxy'>body text</agent-message>`)
    expect(r.sender).toBe("csp-and-proxy")
    expect(r.body).toBe("body text")
  })

  it("keeps a > that appears inside the body", () => {
    const r = parseAgentEnvelope(`<agent-message from="a">1 > 0, so the guard holds</agent-message>`)
    expect(r.sender).toBe("a")
    expect(r.body).toBe("1 > 0, so the guard holds")
  })
})

describe("parseAgentEnvelope matched", () => {
  it("reports a match for an envelope that names no sender", () => {
    const r = parseAgentEnvelope(`<teammate-message>hello there</teammate-message>`)
    expect(r.matched).toBe(true)
    expect(r.sender).toBeNull()
    expect(r.body).toBe("hello there")
  })

  it("reports no match for plain text that unwraps to the same body", () => {
    const r = parseAgentEnvelope("hello there")
    expect(r.matched).toBe(false)
    expect(r.sender).toBeNull()
    expect(r.body).toBe("hello there")
  })

  it("reports a match when an envelope carries a sender", () => {
    expect(parseAgentEnvelope(`<agent-message from="a">one</agent-message>`).matched).toBe(true)
  })
})

describe("looksLikeQuestion false positives", () => {
  it("stays quiet when 'should i' is only the start of a longer word", () => {
    expect(looksLikeQuestion("Done. The bundle should include the polyfill now; verify is PASS.")).toBe(false)
    expect(looksLikeQuestion("Landed. The linter should identify the remaining cases automatically.")).toBe(false)
    expect(looksLikeQuestion("Fixed: the watcher should ignore node_modules. All gates green.")).toBe(false)
    expect(looksLikeQuestion("Shipped. The postinstall step should install the hook on first run.")).toBe(false)
  })

  it("stays quiet on a sign-off that merely offers more work", () => {
    expect(
      looksLikeQuestion("Batch 3 done, all four gates PASS. Let me know if you want the middleware hunk too."),
    ).toBe(false)
  })

  it("ignores a ? that belongs to a URL query string", () => {
    expect(looksLikeQuestion("Shipped. Deploy log: https://ci.example.com/build?id=8891")).toBe(false)
  })

  it("ignores a quoted question the report already answered", () => {
    const report = [
      Array.from({ length: 60 }, () => "Touched the paging cache and the fixture helpers along the way.").join("\n"),
      "> Should the flag default to on?",
      "Answered above: yes, it defaults to on.",
      "All four gates PASS.",
    ].join("\n")
    expect(looksLikeQuestion(report)).toBe(false)
  })

  it("still fires on a short body that is only a question", () => {
    expect(looksLikeQuestion("Ship it?")).toBe(true)
  })
})
