// @vitest-environment node
import { describe, expect, it } from "vitest"
import { chunkMessage, toMrkdwn } from "../../slack/mrkdwn"
import { checkPost } from "../../slack/outbound"
import type { SlackLink, SlackState } from "../../slack/types"

const DM = "D0BK06FJKHD"
const link: SlackLink = { sessionId: "s1", bot: "odyssey", allow: ["U01TRP22K28"], dms: [DM], channels: [], autoPost: false, dailyCap: 3, createdAt: 1 }
const state = (sent: SlackState["sent"] = []): SlackState => ({ version: 1, links: { s1: link }, inbox: [], threads: {}, sent })
const NOON = Date.parse("2026-10-28T12:00:00Z")

describe("checkPost", () => {
  it("refuses channels the link does not list", () => {
    expect(checkPost(state(), link, { channel: "C0GENERAL", text: "hi" }, NOON)).toMatchObject({ allowed: false, reason: expect.stringContaining("may not post to C0GENERAL") })
    expect(checkPost(state(), { ...link, channels: ["C0GENERAL"] }, { channel: "C0GENERAL", text: "hi" }, NOON).allowed).toBe(true)
  })

  it("drops the same text to the same place within 30 minutes", () => {
    const first = checkPost(state(), link, { channel: DM, threadTs: "1.1", text: "done" }, NOON)
    if (!first.allowed) throw new Error("first post refused")
    const sent = state([{ id: "r1", bot: "odyssey", at: NOON, channel: DM, threadTs: "1.1", hash: first.hash, ts: "2.2" }])
    expect(checkPost(sent, link, { channel: DM, threadTs: "1.1", text: " done " }, NOON + 60_000)).toMatchObject({ allowed: false, duplicate: true })
    expect(checkPost(sent, link, { channel: DM, threadTs: "9.9", text: "done" }, NOON + 60_000).allowed).toBe(true)
    expect(checkPost(sent, link, { channel: DM, threadTs: "1.1", text: "done" }, NOON + 31 * 60_000).allowed).toBe(true)
  })

  it("stops at the daily cap and starts again on the next UTC day", () => {
    const sent = state([1, 2, 3].map((n) => ({ id: `r${n}`, bot: "odyssey", at: NOON - n * 3600_000, channel: DM, hash: `h${n}`, ts: `${n}` })))
    expect(checkPost(sent, link, { channel: DM, text: "fourth" }, NOON)).toMatchObject({ allowed: false, reason: expect.stringContaining("Daily cap of 3") })
    expect(checkPost(sent, link, { channel: DM, text: "fourth" }, Date.parse("2026-10-29T00:01:00Z")).allowed).toBe(true)
    expect(checkPost(state(sent.sent.slice(0, 2)), link, { channel: DM, text: "two chunks" }, NOON, 2)).toMatchObject({ allowed: false, reason: expect.stringContaining("needs 2, 1 left") })
  })
})

describe("toMrkdwn", () => {
  it("converts emphasis, headings, strikes and links", () => {
    expect(toMrkdwn("# Plan\n**bold** and *it* and ~~gone~~, see [the PR](https://x.test/1)")).toBe("*Plan*\n*bold* and _it_ and ~gone~, see <https://x.test/1|the PR>")
  })

  it("leaves code and Slack entities alone and escapes the rest", () => {
    expect(toMrkdwn("`**a** <b>` and ```\n**raw**\n``` hi <@U1> a < b & c")).toBe("`**a** <b>` and ```\n**raw**\n``` hi <@U1> a &lt; b &amp; c")
  })

  it("keeps quote markers and list bullets", () => {
    expect(toMrkdwn("> quoted\n* item\n- other")).toBe("> quoted\n* item\n- other")
  })
})

describe("chunkMessage", () => {
  it("keeps short text whole", () => {
    expect(chunkMessage("short")).toEqual(["short"])
  })

  it("splits on paragraphs and closes a code fence left open", () => {
    const chunks = chunkMessage(`${"a".repeat(60)}\n\n\`\`\`\n${"b".repeat(60)}\n${"c".repeat(60)}\n\`\`\``, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect((chunk.match(/```/g)?.length ?? 0) % 2).toBe(0)
    expect(chunks[0]).toMatch(/\(1\/\d\)_$/)
  })
})
