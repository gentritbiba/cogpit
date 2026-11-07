import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DelegatedTask } from "../../../shared/contracts/orchestration"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))

import { useDelegatedTaskCounts } from "../useDelegatedTaskCounts"

const task = (id: string, patch: Partial<DelegatedTask> = {}): DelegatedTask => ({
  id, parentSessionId: "lead", childSessionId: id, sourceId: id, state: "running", createdAt: 1, updatedAt: 1, ...patch,
})
const counted = (counts: object, etag = '"v1"') => Response.json({ counts }, { headers: { ETag: etag } })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.fetch.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe("useDelegatedTaskCounts", () => {
  it("asks for the counts view and resends the ETag, keeping the counts on 304", async () => {
    mocks.fetch.mockResolvedValueOnce(counted({ total: 2, running: 1, unread: 2, unreadRunning: 1 }))
    mocks.fetch.mockResolvedValue(new Response(null, { status: 304 }))
    const { result } = renderHook(() => useDelegatedTaskCounts("lead"))
    await waitFor(() => expect(result.current.total).toBe(2))
    const first = result.current
    expect(mocks.fetch.mock.calls[0]![0]).toBe("/api/delegated-tasks?sessionId=lead&view=counts")
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(mocks.fetch.mock.calls[1]![1].headers).get("If-None-Match")).toBe('"v1"')
    expect(result.current).toBe(first)
  })

  it("keeps the same object when a changed body counts the same", async () => {
    mocks.fetch.mockResolvedValueOnce(counted({ total: 1, running: 1, unread: 1, unreadRunning: 1 }))
    mocks.fetch.mockResolvedValue(counted({ total: 1, running: 1, unread: 1, unreadRunning: 1 }, '"v2"'))
    const { result } = renderHook(() => useDelegatedTaskCounts("lead-same"))
    await waitFor(() => expect(result.current.total).toBe(1))
    const first = result.current
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(result.current).toBe(first)
  })

  it("counts the task list an older server sends instead", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ tasks: [task("a"), task("b", { state: "completed", acknowledgedAt: 2 })] }))
    const { result } = renderHook(() => useDelegatedTaskCounts("lead-old"))
    await waitFor(() => expect(result.current).toEqual({ total: 2, running: 1, unread: 1, unreadRunning: 1 }))
  })

  it("polls once for every place that shows the same session", async () => {
    mocks.fetch.mockResolvedValue(counted({ total: 1, running: 0, unread: 1, unreadRunning: 0 }))
    const first = renderHook(() => useDelegatedTaskCounts("lead-shared"))
    const second = renderHook(() => useDelegatedTaskCounts("lead-shared"))
    await waitFor(() => expect(second.result.current.total).toBe(1))
    expect(first.result.current.total).toBe(1)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})
