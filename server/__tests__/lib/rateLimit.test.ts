// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import type { IncomingMessage } from "node:http"
import { isRateLimited } from "../../lib/rateLimit"

// ── isRateLimited ───────────────────────────────────────────────────────

describe("isRateLimited", () => {
  function mockReq(ip: string): IncomingMessage {
    return { socket: { remoteAddress: ip } } as unknown as IncomingMessage
  }

  it("allows first request", () => {
    const req = mockReq("10.0.0.1")
    expect(isRateLimited(req)).toBe(false)
  })

  it("allows up to 5 requests within window", () => {
    const req = mockReq("10.0.0.2")
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(req)).toBe(false)
    }
  })

  it("blocks the 6th request within window", () => {
    const req = mockReq("10.0.0.3")
    for (let i = 0; i < 5; i++) {
      isRateLimited(req)
    }
    expect(isRateLimited(req)).toBe(true)
  })

  it("resets after window expires", () => {
    const req = mockReq("10.0.0.4")
    // Exhaust the limit
    for (let i = 0; i < 6; i++) {
      isRateLimited(req)
    }
    expect(isRateLimited(req)).toBe(true)

    // Advance time past the window (60s)
    vi.useFakeTimers()
    vi.advanceTimersByTime(61_000)
    expect(isRateLimited(req)).toBe(false)
    vi.useRealTimers()
  })
})

// ── isRateLimited isolation ─────────────────────────────────────────────

describe("isRateLimited isolation between IPs", () => {
  it("rate limits are per-IP", () => {
    const req1 = { socket: { remoteAddress: "10.1.0.1" } } as unknown as IncomingMessage
    const req2 = { socket: { remoteAddress: "10.1.0.2" } } as unknown as IncomingMessage

    // Exhaust limit for req1
    for (let i = 0; i < 6; i++) isRateLimited(req1)
    expect(isRateLimited(req1)).toBe(true)

    // req2 should still be allowed
    expect(isRateLimited(req2)).toBe(false)
  })

  it("isolates forwarded clients sharing one tunnel connector", () => {
    const forwardedReq = (ip: string) => ({
      socket: { remoteAddress: "127.0.0.2" },
      headers: { "cf-connecting-ip": ip },
    }) as unknown as IncomingMessage

    for (let i = 0; i < 6; i++) isRateLimited(forwardedReq("203.0.113.1"))
    expect(isRateLimited(forwardedReq("203.0.113.1"))).toBe(true)
    expect(isRateLimited(forwardedReq("203.0.113.2"))).toBe(false)
  })

  it("keeps a connector-wide ceiling even when forwarding headers vary", () => {
    let limited = false
    for (let i = 0; i < 31; i++) {
      const req = {
        socket: { remoteAddress: "127.0.0.3" },
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      } as unknown as IncomingMessage
      limited = isRateLimited(req)
    }
    expect(limited).toBe(true)
  })
})
