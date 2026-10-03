import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn(), hubFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { useSessionAccess } from "@/hooks/useSessionAccess"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { __resetIdentityForTest, setActiveIdentity } from "@/lib/device"
import {
  __resetSessionAccessForTest,
  learnListedAccess,
  rememberCreatedSession,
  sessionAccessTicket,
} from "@/lib/sessionAccess"
import { SESSION_ACCESS_CHANGED_EVENT } from "@/lib/sessionAccessEvents"
import { type MeResponse, NO_CAPABILITIES } from "../../../shared/contracts/identity"
import { SESSION_ACCESS_HEADER, type SessionAccessLookup } from "../../../shared/contracts/sessionAccess"

const mockedAuthFetch = vi.mocked(authFetch)
const SESSION = "11111111-1111-4111-8111-111111111111"
const ALICE = { id: "u_alice", username: "alice", displayName: "Alice" }
const BOB = { id: "u_bob", username: "bob", displayName: "Bob" }

function signIn(user: typeof ALICE): void {
  const me: MeResponse = {
    authenticated: true,
    edition: "team",
    user: { ...user },
    capabilities: NO_CAPABILITIES,
    enforcesSessionAccess: true,
  }
  setMe(me)
  setActiveIdentity(user.id)
}

function answer(lookup: SessionAccessLookup): void {
  mockedAuthFetch.mockImplementation(async () => new Response(JSON.stringify(lookup), { status: 200 }))
}

const VIEW: SessionAccessLookup = { sessionId: SESSION, level: "view" }

describe("useSessionAccess", () => {
  beforeEach(() => {
    mockedAuthFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
    __resetSessionAccessForTest()
  })

  it("is the user's own session in personal edition without asking the server", () => {
    const { result } = renderHook(() => useSessionAccess(SESSION))

    expect(result.current).toEqual({ level: "own" })
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("permits nothing while the identity is unresolved, and asks nobody", () => {
    setMe(null)
    const open = renderHook(() => useSessionAccess(SESSION))
    const composing = renderHook(() => useSessionAccess(null))

    expect(open.result.current.level).toBe("unknown")
    expect(composing.result.current.level).toBe("unknown")
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("treats a session that does not exist yet as the user's own", () => {
    signIn(BOB)
    const { result } = renderHook(() => useSessionAccess(null))

    expect(result.current.level).toBe("own")
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("is unknown where access is enforced until the server says, then reads its level", async () => {
    signIn(BOB)
    answer(VIEW)
    const { result } = renderHook(() => useSessionAccess(SESSION))

    expect(result.current.level).toBe("unknown")
    await waitFor(() => expect(result.current).toEqual({ level: "view" }))
    expect(mockedAuthFetch).toHaveBeenCalledWith(`/api/session-access/${SESSION}`)
  })

  it("starts from what a session list said while the server answers", () => {
    signIn(BOB)
    mockedAuthFetch.mockReturnValue(new Promise(() => {}))
    learnListedAccess([{
      sessionId: SESSION,
      access: { level: "interact", mine: false },
    }], sessionAccessTicket())

    const { result } = renderHook(() => useSessionAccess(SESSION))

    expect(result.current.level).toBe("interact")
  })

  it("owns a session this client just created without waiting for the server", () => {
    signIn(BOB)
    mockedAuthFetch.mockReturnValue(new Promise(() => {}))
    rememberCreatedSession(SESSION)

    const { result } = renderHook(() => useSessionAccess(SESSION))

    expect(result.current.level).toBe("own")
  })

  it("stays unknown through a failed lookup and asks again until the server answers", async () => {
    vi.useFakeTimers()
    signIn(BOB)
    mockedAuthFetch
      .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(VIEW)))
    const { result } = renderHook(() => useSessionAccess(SESSION))

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.level).toBe("unknown")

    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
    expect(result.current.level).toBe("view")
  })

  it("reports no access after the server's definite no", async () => {
    signIn(BOB)
    mockedAuthFetch.mockResolvedValue(new Response("{}", { status: 404, headers: { [SESSION_ACCESS_HEADER]: "none" } }))
    const { result } = renderHook(() => useSessionAccess(SESSION))

    await waitFor(() => expect(result.current.level).toBe("none"))
  })

  it("keeps the answer per signed-in user", async () => {
    signIn(BOB)
    answer(VIEW)
    const first = renderHook(() => useSessionAccess(SESSION))
    await waitFor(() => expect(first.result.current.level).toBe("view"))
    first.unmount()

    signIn(ALICE)
    mockedAuthFetch.mockReturnValue(new Promise(() => {}))
    const second = renderHook(() => useSessionAccess(SESSION))
    expect(second.result.current.level).toBe("unknown")
    second.unmount()

    signIn(BOB)
    const third = renderHook(() => useSessionAccess(SESSION))
    expect(third.result.current.level).toBe("view")
  })

  it("asks again when a server change names the session", async () => {
    signIn(BOB)
    answer(VIEW)
    const { result } = renderHook(() => useSessionAccess(SESSION))
    await waitFor(() => expect(result.current.level).toBe("view"))

    answer({ ...VIEW, level: "interact" })
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: "other" } }))
    })
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_CHANGED_EVENT, { detail: { sessionId: SESSION } }))
    })
    await waitFor(() => expect(result.current.level).toBe("interact"))
  })
})
