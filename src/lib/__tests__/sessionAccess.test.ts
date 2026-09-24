import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import {
  __resetSessionAccessForTest,
  knownSessionAccess,
  learnListedAccess,
  onListsStale,
  publishListsStale,
  publishSessionAccess,
  refreshSessionAccess,
  rememberCreatedSession,
  sessionAccessTicket,
  subscribeSessionAccess,
  watchSessionAccess,
} from "@/lib/sessionAccess"
import { SESSION_ACCESS_CHANGED_EVENT } from "@/lib/sessionAccessEvents"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"
import {
  type ListedAccess,
  SESSION_ACCESS_HEADER,
  type SessionAccessLookup,
} from "../../../shared/contracts/sessionAccess"

const mockedAuthFetch = vi.mocked(authFetch)
const SESSION = "sess-1"
const ALICE = { id: "u_alice", username: "alice", displayName: "Alice" }
const OWNED: SessionAccessLookup = { sessionId: SESSION, level: "own" }

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function answer(body: unknown, status = 200, headers: Record<string, string> = {}): void {
  mockedAuthFetch.mockResolvedValueOnce(reply(body, status, headers))
}

/** The server's definite no: a hidden session's 404 names the caller's level as none. */
function hidden(): Response {
  return reply({ error: "Session not found", code: "NOT_FOUND" }, 404, { [SESSION_ACCESS_HEADER]: "none" })
}

function deferred(): { promise: Promise<Response>; resolve: (res: Response) => void } {
  let resolve!: (res: Response) => void
  const promise = new Promise<Response>((settle) => { resolve = settle })
  return { promise, resolve }
}

function listed(sessionId: string, access?: ListedAccess) {
  return { sessionId, access }
}

describe("session access store", () => {
  beforeEach(() => {
    mockedAuthFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetSessionAccessForTest()
    __resetCapabilitiesForTest()
  })

  it("asks core's lookup for the session", async () => {
    answer(OWNED)

    expect(await refreshSessionAccess("a b")).toBe("own")
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/session-access/a%20b")
  })

  it("keeps the last answer when the server refuses, fails or answers something else", async () => {
    answer(OWNED)
    expect(await refreshSessionAccess(SESSION)).toBe("own")

    answer({ error: "Forbidden" }, 403)
    expect(await refreshSessionAccess(SESSION)).toBeNull()
    answer({ sessionId: SESSION, level: "admin" })
    expect(await refreshSessionAccess(SESSION)).toBeNull()
    mockedAuthFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    expect(await refreshSessionAccess(SESSION)).toBeNull()

    expect(knownSessionAccess(SESSION)).toBe("own")
  })

  it("records a hidden session's 404 as no access", async () => {
    answer(OWNED)
    await refreshSessionAccess(SESSION)

    mockedAuthFetch.mockResolvedValueOnce(hidden())

    expect(await refreshSessionAccess(SESSION)).toBe("none")
    expect(knownSessionAccess(SESSION)).toBe("none")
  })

  it("reads a 404 without the access header as no answer, as a server without the lookup gives", async () => {
    answer({ error: "Not found" }, 404)

    expect(await refreshSessionAccess(SESSION)).toBeNull()
    expect(knownSessionAccess(SESSION)).toBeUndefined()
  })

  it("sends one request per session while it is in flight", async () => {
    const pending = deferred()
    mockedAuthFetch.mockReturnValueOnce(pending.promise)

    const first = refreshSessionAccess(SESSION)
    const second = refreshSessionAccess(SESSION)
    pending.resolve(reply(OWNED))

    expect(await first).toEqual(await second)
    expect(mockedAuthFetch).toHaveBeenCalledOnce()
  })

  it("ignores an answer that was asked for before a newer one arrived", async () => {
    const pending = deferred()
    mockedAuthFetch.mockReturnValueOnce(pending.promise)
    const stale = refreshSessionAccess(SESSION)

    publishSessionAccess(SESSION, "view", sessionAccessTicket())
    pending.resolve(reply(OWNED))

    expect(await stale).toBe("view")
    expect(knownSessionAccess(SESSION)).toBe("view")
  })

  it("tells store subscribers about an accepted change without asking views to read it again", () => {
    const rendered = vi.fn()
    const reread = vi.fn()
    const unsubscribe = subscribeSessionAccess(rendered)
    window.addEventListener(SESSION_ACCESS_CHANGED_EVENT, reread)

    publishSessionAccess(SESSION, "own", sessionAccessTicket())
    publishSessionAccess(SESSION, "own", sessionAccessTicket())

    expect(knownSessionAccess(SESSION)).toBe("own")
    expect(rendered).toHaveBeenCalledOnce()
    expect(reread).not.toHaveBeenCalled()
    unsubscribe()
    window.removeEventListener(SESSION_ACCESS_CHANGED_EVENT, reread)
  })

  it("learns each listed row's level and tells subscribers only when one changed", () => {
    const rendered = vi.fn()
    const unsubscribe = subscribeSessionAccess(rendered)

    learnListedAccess([
      listed(SESSION, { level: "own", mine: true }),
      listed("sess-2", { level: "view", mine: false }),
      listed("personal-row"),
    ], sessionAccessTicket())

    expect(knownSessionAccess(SESSION)).toBe("own")
    expect(knownSessionAccess("sess-2")).toBe("view")
    expect(knownSessionAccess("personal-row")).toBeUndefined()
    expect(rendered).toHaveBeenCalledOnce()

    learnListedAccess([listed("sess-2", { level: "view", mine: false })], sessionAccessTicket())
    expect(rendered).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("does not let a list read before a newer answer overwrite it", () => {
    const listTicket = sessionAccessTicket()
    publishSessionAccess(SESSION, "interact", sessionAccessTicket())

    learnListedAccess([listed(SESSION, { level: "view", mine: false })], listTicket)

    expect(knownSessionAccess(SESSION)).toBe("interact")
  })

  it("remembers a session this client created as the creator's own where access is enforced", () => {
    rememberCreatedSession(SESSION)
    expect(knownSessionAccess(SESSION)).toBeUndefined()

    setMe({
      authenticated: true,
      edition: "team",
      user: { ...ALICE },
      capabilities: NO_CAPABILITIES,
      enforcesSessionAccess: true,
    })
    rememberCreatedSession(SESSION)

    expect(knownSessionAccess(SESSION)).toBe("own")
  })

  it("tells lists they are stale until they stop listening", () => {
    const stale = vi.fn()
    const stop = onListsStale(stale)

    publishListsStale()
    expect(stale).toHaveBeenCalledOnce()

    stop()
    publishListsStale()
    expect(stale).toHaveBeenCalledOnce()
  })

  describe("watchSessionAccess", () => {
    it("retries a failed read with growing delays until the server answers", async () => {
      vi.useFakeTimers()
      mockedAuthFetch
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
        .mockResolvedValueOnce(reply(OWNED))
      const stop = watchSessionAccess(SESSION)

      await vi.advanceTimersByTimeAsync(0)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(3)
      expect(knownSessionAccess(SESSION)).toBe("own")

      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(3)
      stop()
    })

    it("waits at most 30 seconds between retries", async () => {
      vi.useFakeTimers()
      mockedAuthFetch.mockImplementation(async () => new Response("Unavailable", { status: 503 }))
      const stop = watchSessionAccess(SESSION)

      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(29_999)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(7)
      stop()
    })

    it("stops asking after the server's definite no", async () => {
      vi.useFakeTimers()
      mockedAuthFetch.mockImplementation(async () => hidden())
      const stop = watchSessionAccess(SESSION)

      await vi.advanceTimersByTimeAsync(120_000)

      expect(mockedAuthFetch).toHaveBeenCalledOnce()
      expect(knownSessionAccess(SESSION)).toBe("none")
      stop()
    })

    it("keeps asking through a 404 that says nothing about the session", async () => {
      vi.useFakeTimers()
      mockedAuthFetch.mockImplementation(async () => reply({ error: "Not found" }, 404))
      const stop = watchSessionAccess(SESSION)

      await vi.advanceTimersByTimeAsync(1_000 + 2_000)

      expect(mockedAuthFetch).toHaveBeenCalledTimes(3)
      expect(knownSessionAccess(SESSION)).toBeUndefined()
      stop()
    })

    it("reads again when a server change names the session, and not after it stops", async () => {
      mockedAuthFetch.mockImplementation(async () => reply(OWNED))
      const stop = watchSessionAccess(SESSION)
      await vi.waitFor(() => expect(knownSessionAccess(SESSION)).toBeDefined())

      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: "other" } }))
      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: SESSION } }))
      await vi.waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledTimes(2))

      stop()
      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: SESSION } }))
      await Promise.resolve()
      expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
    })

    it("asks afresh when the server changes access while a read is still out", async () => {
      const early = deferred()
      mockedAuthFetch
        .mockReturnValueOnce(early.promise)
        .mockResolvedValueOnce(reply({ ...OWNED, level: "view" }))
      const stop = watchSessionAccess(SESSION)
      await vi.waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledOnce())

      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: SESSION } }))
      await vi.waitFor(() => expect(knownSessionAccess(SESSION)).toBe("view"))
      early.resolve(reply(OWNED))
      await Promise.resolve()

      expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
      await vi.waitFor(() => expect(knownSessionAccess(SESSION)).toBe("view"))
      stop()
    })

    it("does not retry for an older read that failed after a newer one answered", async () => {
      vi.useFakeTimers()
      const early = deferred()
      mockedAuthFetch
        .mockReturnValueOnce(early.promise)
        .mockResolvedValueOnce(reply(OWNED))
      const stop = watchSessionAccess(SESSION)
      await vi.advanceTimersByTimeAsync(0)

      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: SESSION } }))
      await vi.advanceTimersByTimeAsync(0)
      early.resolve(new Response("Unavailable", { status: 503 }))
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
      stop()
    })

    it("cancels a pending retry when it stops", async () => {
      vi.useFakeTimers()
      mockedAuthFetch.mockImplementation(async () => new Response("Unavailable", { status: 503 }))
      const stop = watchSessionAccess(SESSION)
      await vi.advanceTimersByTimeAsync(0)

      stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mockedAuthFetch).toHaveBeenCalledOnce()
    })
  })
})
