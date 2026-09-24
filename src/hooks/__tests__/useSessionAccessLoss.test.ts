import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ParsedSession } from "../../../shared/session/types"

const mocks = vi.hoisted(() => ({ removeSession: vi.fn(), toastError: vi.fn() }))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventory: () => ({ removeSession: mocks.removeSession }),
}))
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))

import { ACCESS_LOST_MESSAGE, NO_ACCESS_MESSAGE, useSessionAccessLoss } from "@/hooks/useSessionAccessLoss"
import {
  __resetSessionAccessForTest,
  forgetSessionAccess,
  knownSessionAccess,
  learnListedAccess,
  onListsStale,
  sessionAccessTicket,
} from "@/lib/sessionAccess"
import { SESSION_ACCESS_CHANGED_EVENT, SESSION_ACCESS_LOST_EVENT, trackDeletion } from "@/lib/sessionAccessEvents"
import { sessionCache } from "@/lib/sessionCache"
import { activeSessionsCacheKey, clearSessionListCache, readCachedList, writeCachedList } from "@/lib/sessionListCache"

const OPEN = "00000000-0000-4000-8000-000000000001"
const OTHER = "00000000-0000-4000-8000-000000000002"

/** Deleted sessions stay quiet for a while, so each test that deletes one uses its own. */
const DELETED = "00000000-0000-4000-8000-000000000003"
const DELETING = "00000000-0000-4000-8000-000000000004"
const KEPT = "00000000-0000-4000-8000-000000000005"

async function announce(type: string, sessionId: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(type, { detail: { sessionId } }))
  })
}

function deferred(): { promise: Promise<boolean>; resolve: (deleted: boolean) => void } {
  let resolve!: (deleted: boolean) => void
  const promise = new Promise<boolean>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe("useSessionAccessLoss", () => {
  const leave = vi.fn()
  const forgetVisits = vi.fn()
  const listsRefetch = vi.fn()
  let stopListening: () => void

  function renderListener(openSessionId: string): void {
    renderHook(() => useSessionAccessLoss({ openSessionId, leave, forgetVisits }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stopListening = onListsStale(listsRefetch)
  })

  afterEach(() => {
    stopListening()
    sessionCache.clear()
    clearSessionListCache()
    __resetSessionAccessForTest()
  })

  it("forgets a lost session everywhere, says so once, and leaves it when it is open", async () => {
    renderListener(OPEN)
    sessionCache.set("-work", `${OPEN}.jsonl`, { turns: [] } as unknown as ParsedSession, "", 0, false)
    writeCachedList(activeSessionsCacheKey("shared"), [{ sessionId: OPEN }, { sessionId: OTHER }])
    learnListedAccess([{ sessionId: OPEN, access: { level: "view", mine: false } }], sessionAccessTicket())

    await announce(SESSION_ACCESS_LOST_EVENT, OPEN)
    await announce(SESSION_ACCESS_LOST_EVENT, OPEN)

    expect(sessionCache.get("-work", `${OPEN}.jsonl`)).toBeUndefined()
    expect(readCachedList(activeSessionsCacheKey("shared"))).toEqual([{ sessionId: OTHER }])
    expect(knownSessionAccess(OPEN)).toBe("none")
    expect(mocks.removeSession).toHaveBeenCalledWith(OPEN)
    expect(forgetVisits).toHaveBeenCalledWith(OPEN)
    expect(listsRefetch).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(ACCESS_LOST_MESSAGE, { id: `session-access-lost:${OPEN}` })
    expect(new Set(mocks.toastError.mock.calls.map(([, options]) => options.id)).size).toBe(1)
    expect(leave).toHaveBeenCalled()
  })

  it("tells a caller who never had the session that they have no access, rather than that they lost it", async () => {
    renderListener(OPEN)

    await announce(SESSION_ACCESS_LOST_EVENT, OPEN)

    expect(mocks.toastError).toHaveBeenCalledWith(NO_ACCESS_MESSAGE, { id: `session-access-lost:${OPEN}` })
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(leave).toHaveBeenCalled()
  })

  it("says the access was lost for a session this client once had, whatever it learned since", async () => {
    renderListener(OPEN)
    learnListedAccess([{ sessionId: OPEN, access: { level: "view", mine: false } }], sessionAccessTicket())
    forgetSessionAccess(OPEN)

    await announce(SESSION_ACCESS_LOST_EVENT, OPEN)

    expect(mocks.toastError).toHaveBeenCalledWith(ACCESS_LOST_MESSAGE, { id: `session-access-lost:${OPEN}` })
  })

  it("forgets a session a background request found lost without a word, unless it is the open one", async () => {
    renderListener(OPEN)
    learnListedAccess([{ sessionId: OPEN, access: { level: "view", mine: false } }], sessionAccessTicket())
    const announceBackground = (sessionId: string) => act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_ACCESS_LOST_EVENT, { detail: { sessionId, background: true } }))
    })

    await announceBackground(OTHER)
    expect(mocks.removeSession).toHaveBeenCalledWith(OTHER)
    expect(forgetVisits).toHaveBeenCalledWith(OTHER)
    expect(mocks.toastError).not.toHaveBeenCalled()

    await announceBackground(OPEN)
    expect(leave).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(ACCESS_LOST_MESSAGE, { id: `session-access-lost:${OPEN}` })
  })

  it("stays in the open session when another one is lost", async () => {
    renderListener(OPEN)
    await announce(SESSION_ACCESS_LOST_EVENT, OTHER)
    expect(mocks.removeSession).toHaveBeenCalledWith(OTHER)
    expect(leave).not.toHaveBeenCalled()
  })

  it("lists again when the server changes the caller's level on a session", async () => {
    renderListener(OPEN)
    await announce(SESSION_ACCESS_CHANGED_EVENT, OTHER)
    expect(listsRefetch).toHaveBeenCalledOnce()
    expect(mocks.removeSession).not.toHaveBeenCalled()
  })

  it("closes a session the caller deleted and forgets it everywhere, without a word of lost access", async () => {
    renderListener(DELETED)
    sessionCache.set("-work", `${DELETED}.jsonl`, { turns: [] } as unknown as ParsedSession, "", 0, false)
    writeCachedList(activeSessionsCacheKey("mine"), [{ sessionId: DELETED }, { sessionId: OTHER }])

    await act(() => trackDeletion(DELETED, Promise.resolve(true)))

    expect(sessionCache.get("-work", `${DELETED}.jsonl`)).toBeUndefined()
    expect(readCachedList(activeSessionsCacheKey("mine"))).toEqual([{ sessionId: OTHER }])
    expect(mocks.removeSession).toHaveBeenCalledWith(DELETED)
    expect(forgetVisits).toHaveBeenCalledWith(DELETED)
    expect(leave).toHaveBeenCalled()

    // What the delete took away still reaches the caller: its stream, a reconnect, a request in flight.
    await announce(SESSION_ACCESS_LOST_EVENT, DELETED)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("waits on a delete under way before calling its session's loss a loss", async () => {
    renderListener(DELETING)
    const mine = { level: "own", mine: true } as const
    learnListedAccess([{ sessionId: DELETING, access: mine }, { sessionId: KEPT, access: mine }], sessionAccessTicket())
    const deleting = deferred()
    const kept = deferred()
    void trackDeletion(DELETING, deleting.promise)
    void trackDeletion(KEPT, kept.promise)

    // The session's own stream can hear the delete before the delete's answer arrives.
    await announce(SESSION_ACCESS_LOST_EVENT, DELETING)
    await announce(SESSION_ACCESS_LOST_EVENT, KEPT)
    expect(leave).toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    await act(async () => {
      deleting.resolve(true)
      kept.resolve(false)
    })

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(ACCESS_LOST_MESSAGE, { id: `session-access-lost:${KEPT}` })
  })
})
