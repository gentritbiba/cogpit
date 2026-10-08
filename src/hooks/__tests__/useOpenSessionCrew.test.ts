import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { DelegatedTask } from "../../../shared/contracts/orchestration"

const state = vi.hoisted(() => ({ sessions: [] as ActiveSessionInfo[], tasks: [] as DelegatedTask[] }))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: state.sessions, procBySession: new Map() }),
}))
vi.mock("@/contexts/PendingHumanInputContext", () => ({ usePendingHumanInputOptional: () => null }))
vi.mock("@/hooks/useDelegatedTasks", () => ({ useDelegatedTasks: () => state.tasks }))

import { useOpenSessionCrew } from "../useOpenSessionCrew"

const row = (sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo => ({
  sessionId, dirName: "-d", fileName: `${sessionId}.jsonl`, projectShortName: "p", lastModified: "", size: 1, ...overrides,
})
const task = (childSessionId: string, state: DelegatedTask["state"]): DelegatedTask => ({
  id: childSessionId, parentSessionId: "lead", childSessionId, sourceId: childSessionId, state, createdAt: 1, updatedAt: 1,
})

describe("useOpenSessionCrew", () => {
  it("counts a crew from the session list", () => {
    state.sessions = [row("lead"), row("lane", { crew: { rootId: "lead", parentId: "lead", startedAt: 1 } })]
    state.tasks = []
    expect(renderHook(() => useOpenSessionCrew("lane")).result.current).toMatchObject({ rootId: "lead", size: 1 })
  })

  it("knows a crew from the tasks it handed out when no member is listed here", () => {
    state.sessions = [row("lead")]
    state.tasks = [task("remote-1", "running"), task("remote-2", "completed")]
    expect(renderHook(() => useOpenSessionCrew("lead")).result.current).toEqual({ rootId: "lead", size: 2, needsYou: 0, working: 1 })
  })

  it("is null for a session in no crew", () => {
    state.sessions = [row("solo")]
    state.tasks = []
    expect(renderHook(() => useOpenSessionCrew("solo")).result.current).toBeNull()
  })
})
