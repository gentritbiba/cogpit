import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import { NO_DELEGATED_TASKS } from "@/hooks/useDelegatedTaskCounts"
import type { DelegatedTaskCounts } from "../../../shared/contracts/orchestration"

const state = vi.hoisted(() => ({ sessions: [] as ActiveSessionInfo[], tasks: null as DelegatedTaskCounts | null }))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: state.sessions, procBySession: new Map() }),
}))
vi.mock("@/contexts/PendingHumanInputContext", () => ({ usePendingHumanInputOptional: () => null }))
vi.mock("@/hooks/useDelegatedTaskCounts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useDelegatedTaskCounts")>(),
  useDelegatedTaskCounts: () => state.tasks ?? NO_DELEGATED_TASKS,
}))

import { useOpenSessionCrew } from "../useOpenSessionCrew"

const row = (sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo => ({
  sessionId, dirName: "-d", fileName: `${sessionId}.jsonl`, projectShortName: "p", lastModified: "", size: 1, ...overrides,
})

describe("useOpenSessionCrew", () => {
  it("counts a crew from the session list", () => {
    state.sessions = [row("lead"), row("lane", { crew: { rootId: "lead", parentId: "lead", startedAt: 1 } })]
    state.tasks = null
    expect(renderHook(() => useOpenSessionCrew("lane")).result.current).toMatchObject({ rootId: "lead", size: 1 })
  })

  it("knows a crew from the tasks it handed out when no member is listed here", () => {
    state.sessions = [row("lead")]
    state.tasks = { total: 2, running: 1, unread: 2, unreadRunning: 1 }
    expect(renderHook(() => useOpenSessionCrew("lead")).result.current).toEqual({ rootId: "lead", size: 2, needsYou: 0, working: 1 })
  })

  it("is null for a session in no crew", () => {
    state.sessions = [row("solo")]
    state.tasks = null
    expect(renderHook(() => useOpenSessionCrew("solo")).result.current).toBeNull()
  })
})
