// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createShareToken,
  validateShareToken,
  isShareTokenActive,
  revokeShareToken,
  revokeShareTokensForSession,
  revokeAllShareTokens,
  onShareRevoked,
  countShareGuests,
  MAX_SHARE_GUESTS_PER_SESSION,
  setShareCookie,
  getRequestShareToken,
  __resetShareTokensForTest,
} from "../../security"
import { initShareRegistry, createShare, removeShare } from "../../share/registry"

// isShareTokenActive consults the registry, so the sessions these tokens name
// have to actually be shared for the liveness checks to mean anything.
const SESSION_IDS = ["sess-1", "sess-2", "sess-3"] as const

let registryRoot: string

beforeAll(async () => {
  registryRoot = await mkdtemp(join(tmpdir(), "cogpit-share-tokens-"))
  await initShareRegistry(registryRoot)
  for (const sessionId of SESSION_IDS) {
    await createShare({ sessionId, dirName: "-Users-me-proj", fileName: `${sessionId}.jsonl` })
  }
})

afterAll(async () => {
  await rm(registryRoot, { recursive: true, force: true })
})

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

  it("caps live guests per share, evicting the oldest first", () => {
    // Every login mints a fresh token and the cookie is its only holder, so a
    // guest who clears cookies, switches device, or idles out and logs back in
    // adds one. Uncapped they pile up for the whole absolute TTL and the guest
    // count the host reads before deciding to stop sharing drifts upward.
    const over = MAX_SHARE_GUESTS_PER_SESSION + 2
    const tokens = Array.from({ length: over }, (_, i) => createShareToken("sess-1", "ip", `UA/${i}`))

    expect(countShareGuests("sess-1")).toBe(MAX_SHARE_GUESTS_PER_SESSION)
    expect(validateShareToken(tokens[0], "UA/0")).toBeNull()
    expect(validateShareToken(tokens[1], "UA/1")).toBeNull()
    expect(validateShareToken(tokens[2], "UA/2")).toBe("sess-1")
    expect(validateShareToken(tokens[over - 1], `UA/${over - 1}`)).toBe("sess-1")
  })

  it("caps each share separately", () => {
    for (let i = 0; i < MAX_SHARE_GUESTS_PER_SESSION + 2; i++) {
      createShareToken("sess-1", "ip", `UA/${i}`)
    }
    const other = createShareToken("sess-2", "ip", "UA/other")

    expect(countShareGuests("sess-2")).toBe(1)
    expect(validateShareToken(other, "UA/other")).toBe("sess-2")
  })

  it("closes the evicted guest's live transports", () => {
    const revoked: (string | null)[] = []
    const unsubscribe = onShareRevoked((token) => revoked.push(token))
    try {
      const tokens = Array.from(
        { length: MAX_SHARE_GUESTS_PER_SESSION + 1 },
        (_, i) => createShareToken("sess-1", "ip", `UA/${i}`),
      )
      // An evicted guest may be holding an open SSE stream; it has to be told,
      // exactly as a revoked one is.
      expect(revoked).toEqual([tokens[0]])
    } finally { unsubscribe() }
  })

  it("pins a headless token to the empty user agent instead of to nothing", () => {
    // A token minted without a User-Agent is pinned to "", not left unpinned:
    // a client that does send one is a different client.
    const token = createShareToken("sess-1", "ip", "")
    expect(validateShareToken(token, "")).toBe("sess-1")
    expect(validateShareToken(token, "UA/1")).toBeNull()
    expect(validateShareToken(token, "")).toBeNull()
  })

  it("isShareTokenActive goes false once the session stops being shared", async () => {
    await createShare({
      sessionId: "sess-unshared",
      dirName: "-Users-me-proj",
      fileName: "sess-unshared.jsonl",
    })
    const token = createShareToken("sess-unshared", "ip", "UA/1")
    expect(isShareTokenActive(token)).toBe(true)

    // No token revocation, only the record going away — a live SSE stream has
    // nothing else to notice "Stop sharing" by.
    await removeShare("sess-unshared")
    expect(isShareTokenActive(token)).toBe(false)
  })
})
