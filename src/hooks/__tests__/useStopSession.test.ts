import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { permissionsForAccess, type SessionAccessState } from "@/lib/sessionAccessPermissions"
import { useStopSession } from "../useStopSession"

const mocks = vi.hoisted(() => ({
  isLive: false,
  isConnected: false as boolean | null,
  level: "own" as SessionAccessState,
  dirName: "-tmp-project",
  stop: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionControls: () => ({
    isLive: mocks.isLive,
    sessionSource: { dirName: mocks.dirName, fileName: "s.jsonl", watchOffset: 0, loadId: 1 },
    permissions: permissionsForAccess(mocks.level),
    actions: { handleStopSession: mocks.stop },
  }),
  useSessionChatContextOptional: () => (mocks.isConnected === null ? null : { chat: { isConnected: mocks.isConnected } }),
}))

afterEach(() => {
  mocks.isLive = false
  mocks.isConnected = false
  mocks.level = "own"
  mocks.dirName = "-tmp-project"
})

describe("useStopSession", () => {
  it("offers nothing to stop while nothing runs", () => {
    expect(renderHook(() => useStopSession()).result.current).toBeUndefined()
  })

  it("offers the session's stop while its transcript is live", () => {
    mocks.isLive = true
    expect(renderHook(() => useStopSession()).result.current).toBe(mocks.stop)
  })

  it("still offers it while the chat is connected after the transcript stream has gone quiet", () => {
    mocks.isConnected = true
    expect(renderHook(() => useStopSession()).result.current).toBe(mocks.stop)
  })

  it("works outside a chat provider, from the transcript alone", () => {
    mocks.isConnected = null
    mocks.isLive = true
    expect(renderHook(() => useStopSession()).result.current).toBe(mocks.stop)
  })

  it("withholds it from someone who may only watch", () => {
    mocks.isLive = true
    mocks.level = "view"
    expect(renderHook(() => useStopSession()).result.current).toBeUndefined()
  })
})
