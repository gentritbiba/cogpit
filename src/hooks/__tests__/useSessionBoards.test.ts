import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))

import { __resetSessionBoardsForTest, useSessionBoards } from "../useSessionBoards"

const answer = (sessionIds: string[]) => ({
  ok: true,
  json: async () => ({ boards: sessionIds.map((sessionId) => ({ sessionId, rootId: sessionId, sections: [], updatedAt: 1 })) }),
})

beforeEach(() => {
  __resetSessionBoardsForTest()
  mocks.fetch.mockReset()
})

describe("useSessionBoards", () => {
  it("drops the previous device's late answer after the device scope changes", async () => {
    let answerFirstDevice: (value: unknown) => void = () => {}
    mocks.fetch
      .mockReturnValueOnce(new Promise((resolve) => { answerFirstDevice = resolve }))
      .mockResolvedValueOnce(answer(["on-second-device"]))
    const { result, unmount } = renderHook(() => useSessionBoards())

    await act(async () => { window.dispatchEvent(new Event("cogpit-device-scope-changed")) })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect([...result.current.keys()]).toEqual(["on-second-device"])

    await act(async () => { answerFirstDevice(answer(["on-first-device"])) })
    expect([...result.current.keys()]).toEqual(["on-second-device"])
    unmount()
  })
})
