// @vitest-environment node
import { describe, expect, it } from "vitest"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"
import { readRateLimitBlock, SESSION_LIMIT } from "../../../shared/session/rateLimit"
import { readSdkRateLimit } from "../../agents/rateLimit"

/**
 * Reading a runtime's rate-limit report. The block this produces is what puts a
 * hand-off banner in front of the user, so the two ways it can be wrong both
 * matter: a missed block strands the session with no explanation, and a block
 * that over-promises sends someone to a terminal for a mode that cannot help.
 */
describe("readRateLimitBlock", () => {
  const rejected = {
    status: "rejected",
    rateLimitType: SESSION_LIMIT,
    resetsAt: 1_760_000_000,
  }

  it("reads a rejected session limit into a block", () => {
    expect(readRateLimitBlock("claude", rejected)).toEqual({
      limit: SESSION_LIMIT,
      resetsAt: 1_760_000_000,
      lowPriority: true,
    })
  })

  it("returns null while requests are still allowed", () => {
    expect(readRateLimitBlock("claude", { status: "allowed", utilization: 0.4 })).toBeNull()
    expect(readRateLimitBlock("claude", { status: "allowed_warning", utilization: 0.9 })).toBeNull()
  })

  it("returns null for a report that is not an object", () => {
    for (const value of [null, undefined, "rejected", 7, []]) {
      expect(readRateLimitBlock("claude", value)).toBeNull()
    }
  })

  it("still blocks when the runtime names no limit or reset", () => {
    expect(readRateLimitBlock("claude", { status: "rejected" })).toEqual({
      limit: null,
      resetsAt: null,
      lowPriority: false,
    })
  })

  it("ignores a non-finite reset rather than passing NaN to a date", () => {
    const block = readRateLimitBlock("claude", { ...rejected, resetsAt: Number.NaN })
    expect(block?.resetsAt).toBeNull()
  })

  /**
   * Lower priority spends the weekly allowance to get past the session one, so
   * it is the one limit it cannot rescue. Offering the hand-off on a weekly
   * rejection would send the user to a terminal that refuses them too.
   */
  it("does not offer the hand-off for a weekly limit", () => {
    for (const limit of ["seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]) {
      const block = readRateLimitBlock("claude", { ...rejected, rateLimitType: limit })
      expect(block).toEqual({ limit, resetsAt: 1_760_000_000, lowPriority: false })
    }
  })

  it("does not offer the hand-off for an agent whose CLI has no such mode", () => {
    for (const kind of AGENT_KINDS) {
      if (descriptorFor(kind).capabilities.lowPriorityInTerminal) continue
      expect(readRateLimitBlock(kind, rejected)?.lowPriority).toBe(false)
    }
  })

  it("is driven by the capability flag, not by a hardcoded agent", () => {
    const offering = AGENT_KINDS.filter((kind) => descriptorFor(kind).capabilities.lowPriorityInTerminal)
    for (const kind of offering) {
      expect(readRateLimitBlock(kind, rejected)?.lowPriority).toBe(true)
    }
    expect(offering.length).toBeGreaterThan(0)
  })
})

/**
 * `server/sdk-session.ts` drives one specific CLI but sits outside the agent
 * layer, so the kind its reports should be read against is bound here. If that
 * binding ever drifts to an agent without the mode, the hand-off silently
 * stops being offered — hence pinning it to the capability rather than to a
 * name.
 */
describe("readSdkRateLimit", () => {
  it("reads the SDK's report against an agent that offers the hand-off", () => {
    const block = readSdkRateLimit({
      status: "rejected",
      rateLimitType: SESSION_LIMIT,
      resetsAt: 1_760_000_000,
    })
    expect(block).toEqual({ limit: SESSION_LIMIT, resetsAt: 1_760_000_000, lowPriority: true })
  })

  it("lifts the block when the report says the session is served again", () => {
    expect(readSdkRateLimit({ status: "allowed" })).toBeNull()
  })

  it("survives a report the SDK sent without any rate-limit payload", () => {
    expect(readSdkRateLimit(undefined)).toBeNull()
  })
})
