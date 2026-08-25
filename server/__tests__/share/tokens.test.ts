// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  createShareToken,
  validateShareToken,
  isShareTokenActive,
  revokeShareToken,
  revokeShareTokensForSession,
  revokeAllShareTokens,
  onShareRevoked,
  countShareGuests,
  setShareCookie,
  clearShareCookie,
  getRequestShareToken,
  __resetShareTokensForTest,
} from "../../security"

beforeEach(() => { __resetShareTokensForTest() })

describe("share tokens", () => {
  it("round-trips the session it was minted for", () => {
    const token = createShareToken("sess-1", "1.2.3.4", "UA/1")
    expect(validateShareToken(token, "UA/1")).toBe("sess-1")
  })

  it("returns null for an unknown token", () => {
    expect(validateShareToken("deadbeef", "UA/1")).toBeNull()
  })

  it("pins the user agent", () => {
    const token = createShareToken("sess-1", "1.2.3.4", "UA/1")
    expect(validateShareToken(token, "UA/2")).toBeNull()
    // a rejected mismatch also discards the token
    expect(validateShareToken(token, "UA/1")).toBeNull()
  })

  it("revokes every token for one session without touching others", () => {
    const a = createShareToken("sess-1", "ip", "UA/1")
    const b = createShareToken("sess-1", "ip", "UA/2")
    const c = createShareToken("sess-2", "ip", "UA/3")
    revokeShareTokensForSession("sess-1")
    expect(validateShareToken(a, "UA/1")).toBeNull()
    expect(validateShareToken(b, "UA/2")).toBeNull()
    expect(validateShareToken(c, "UA/3")).toBe("sess-2")
  })

  it("counts live guests per session", () => {
    createShareToken("sess-1", "ip", "UA/1")
    createShareToken("sess-1", "ip", "UA/2")
    createShareToken("sess-2", "ip", "UA/3")
    expect(countShareGuests("sess-1")).toBe(2)
    expect(countShareGuests("sess-2")).toBe(1)
    expect(countShareGuests("sess-3")).toBe(0)
  })

  it("expires on the idle timeout", () => {
    vi.useFakeTimers()
    try {
      const token = createShareToken("sess-1", "ip", "UA/1")
      // Past SESSION_IDLE_TTL_MS (30m) but well inside SESSION_ABSOLUTE_TTL_MS
      // (8h), so only the idle rule can reject this.
      vi.advanceTimersByTime(1000 * 60 * 31)
      expect(validateShareToken(token, "UA/1")).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it("expires on the absolute timeout even when continuously active", () => {
    vi.useFakeTimers()
    try {
      const token = createShareToken("sess-1", "ip", "UA/1")
      // Stay inside the idle window the whole way, so only the absolute rule
      // can reject this.
      for (let elapsed = 0; elapsed < 1000 * 60 * 60 * 8; elapsed += 1000 * 60 * 10) {
        vi.advanceTimersByTime(1000 * 60 * 10)
        expect(validateShareToken(token, "UA/1")).toBe("sess-1")
      }
      vi.advanceTimersByTime(1000 * 60 * 10)
      expect(validateShareToken(token, "UA/1")).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it("mints tokens with at least 256 bits of entropy", () => {
    expect(createShareToken("sess-1", "ip", "UA/1")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sets a __Host- cookie that cannot be read by script", () => {
    const headers: string[] = []
    const res = { setHeader: (_n: string, v: string) => headers.push(v) } as never
    setShareCookie(res, "tok")
    expect(headers[0]).toContain("__Host-cogpit_share=tok")
    expect(headers[0]).toContain("HttpOnly")
    expect(headers[0]).toContain("Secure")
    expect(headers[0]).toContain("SameSite=Strict")
    expect(headers[0]).toContain("Path=/")
  })

  it("reads the share token from the cookie only, never a bearer header", () => {
    const withCookie = { headers: { cookie: "__Host-cogpit_share=tok" } } as never
    expect(getRequestShareToken(withCookie)).toBe("tok")
    const withBearer = { headers: { authorization: "Bearer tok" } } as never
    expect(getRequestShareToken(withBearer)).toBeNull()
  })

  it("revokeAllShareTokens clears everything", () => {
    const token = createShareToken("sess-1", "ip", "UA/1")
    revokeAllShareTokens()
    expect(validateShareToken(token, "UA/1")).toBeNull()
  })

  it("revokeShareToken drops exactly that token", () => {
    const a = createShareToken("sess-1", "ip", "UA/1")
    const b = createShareToken("sess-1", "ip", "UA/2")
    revokeShareToken(a)
    expect(validateShareToken(a, "UA/1")).toBeNull()
    expect(validateShareToken(b, "UA/2")).toBe("sess-1")
  })

  it("notifies revocation listeners with the token, and null for a global revoke", () => {
    const seen: Array<string | null> = []
    const unsubscribe = onShareRevoked((token) => { seen.push(token) })
    try {
      const a = createShareToken("sess-1", "ip", "UA/1")
      revokeShareToken(a)
      expect(seen).toEqual([a])

      const b = createShareToken("sess-2", "ip", "UA/2")
      revokeShareTokensForSession("sess-2")
      expect(seen).toEqual([a, b])

      createShareToken("sess-3", "ip", "UA/3")
      revokeAllShareTokens()
      expect(seen).toEqual([a, b, null])
    } finally { unsubscribe() }
  })

  it("stops notifying once unsubscribed", () => {
    const seen: Array<string | null> = []
    onShareRevoked((token) => { seen.push(token) })()
    revokeShareToken(createShareToken("sess-1", "ip", "UA/1"))
    expect(seen).toEqual([])
  })

  it("isShareTokenActive checks validity without refreshing the idle window", () => {
    vi.useFakeTimers()
    try {
      const token = createShareToken("sess-1", "ip", "UA/1")
      vi.advanceTimersByTime(1000 * 60 * 20)
      expect(isShareTokenActive(token)).toBe(true)
      // If the recheck had refreshed lastActivity, the token would survive.
      vi.advanceTimersByTime(1000 * 60 * 20)
      expect(isShareTokenActive(token)).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it("clearShareCookie expires the cookie", () => {
    const headers: string[] = []
    const res = { setHeader: (_n: string, v: string) => headers.push(v) } as never
    clearShareCookie(res)
    expect(headers[0]).toContain("__Host-cogpit_share=;")
    expect(headers[0]).toContain("Max-Age=0")
  })
})
