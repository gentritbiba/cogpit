import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), onInboxRead: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { useNotifications } from "@/hooks/useNotifications"
import type { CogpitNotification } from "../../../shared/notifications"

const GRANTED: CogpitNotification = {
  id: "n1",
  at: "2026-09-24T00:39:00.000Z",
  title: "You can now view “Fix the login bug”",
  body: "Open it to follow along",
  kind: "access",
  sessionId: "00000000-0000-4000-8000-000000000001",
  dirName: "-work-alpha",
  readAt: null,
}

describe("useNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __installEditionUiForTest({ onInboxRead: mocks.onInboxRead })
  })

  afterEach(() => {
    __resetEditionUiForTest()
  })

  it("hands every inbox it reads to the edition", async () => {
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ notifications: [GRANTED] })))

    const { result } = renderHook(() => useNotifications())

    await waitFor(() => expect(result.current.notifications).toEqual([GRANTED]))
    expect(mocks.onInboxRead).toHaveBeenCalledWith([GRANTED])
  })

  it("reads the inbox again when the window gets focus", async () => {
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ notifications: [] })))
    renderHook(() => useNotifications())
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(1))

    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ notifications: [GRANTED] })))
    act(() => { window.dispatchEvent(new Event("focus")) })

    await waitFor(() => expect(mocks.onInboxRead).toHaveBeenLastCalledWith([GRANTED]))
  })

  it("reads the inbox without an edition to hand it to", async () => {
    __resetEditionUiForTest()
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ notifications: [GRANTED] })))

    const { result } = renderHook(() => useNotifications())

    await waitFor(() => expect(result.current.notifications).toEqual([GRANTED]))
    expect(mocks.onInboxRead).not.toHaveBeenCalled()
  })

  it("hands nothing on when the inbox could not be read", async () => {
    mocks.authFetch.mockResolvedValue(new Response("{}", { status: 503 }))

    renderHook(() => useNotifications())

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled())
    await Promise.resolve()
    expect(mocks.onInboxRead).not.toHaveBeenCalled()
  })
})
