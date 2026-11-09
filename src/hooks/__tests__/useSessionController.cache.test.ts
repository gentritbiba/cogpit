import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { sessionCache } from "@/lib/sessionCache"
import type { SessionView } from "../../../shared/session/sessionDigest"
import { useSessionController } from "../useSessionController"

const heldBy = (view: SessionView) => [...sessionCache.heldViews()].filter((held) => held === view).length

describe("useSessionController with the real cache", () => {
  it("lets go of the transcript it shows when its shell unmounts, so the cache may trim it", async () => {
    sessionCache.clear()
    const parsed = { sessionId: "s1", turns: [] } as unknown as SessionView
    sessionCache.set(parsed, { dirName: "-d", fileName: "s1.jsonl", watchOffset: 0, loadId: 1 }, 0, false)
    const { result, unmount } = renderHook(() => useSessionController(vi.fn(), vi.fn()))
    await act(() => result.current.sessions.openSession({ dirName: "-d", fileName: "s1.jsonl" }, { reason: "click", commit: vi.fn() }))
    expect(heldBy(parsed)).toBe(2)

    unmount()

    expect(heldBy(parsed)).toBe(1)
    sessionCache.clear()
  })
})
