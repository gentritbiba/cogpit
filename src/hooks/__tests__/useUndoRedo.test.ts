import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { ParsedSession, Turn, Branch, UndoState } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"

// Mock authFetch before importing useUndoRedo
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  getToken: vi.fn(() => null),
  isRemoteClient: vi.fn(() => false),
}))

// Mock undo-engine functions
vi.mock("@/lib/undo-engine", () => ({
  buildUndoOperations: vi.fn(() => []),
  buildRedoFromArchived: vi.fn(() => []),
  summarizeOperations: vi.fn(() => ({
    turnCount: 1,
    fileCount: 0,
    filePaths: [],
    operationCount: 0,
  })),
  createEmptyUndoState: vi.fn((sessionId: string, totalTurns: number) => ({
    sessionId,
    currentTurnIndex: totalTurns - 1,
    totalTurns,
    branches: [],
    activeBranchId: null,
  })),
  createBranch: vi.fn(),
  collectChildBranches: vi.fn(() => ({ retained: [], scooped: [] })),
  splitChildBranches: vi.fn(() => ({ restored: [], remaining: [] })),
}))

// Mock parseSession for redoGhostTurns
vi.mock("@/lib/parser", () => ({
  parseSession: vi.fn(() => ({ turns: [] })),
}))

import { useUndoRedo } from "@/hooks/useUndoRedo"
import { authFetch } from "@/lib/auth"
import { buildUndoOperations, type FileOperation } from "@/lib/undo-engine"

const mockAuthFetch = vi.mocked(authFetch)
const mockBuildUndo = vi.mocked(buildUndoOperations)

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: `turn-${Math.random().toString(36).slice(2, 8)}`,
    userMessage: "test",
    contentBlocks: [],
    thinking: [],
    assistantText: ["response"],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2025-01-15T10:00:00Z",
    durationMs: 1000,
    tokenUsage: null,
    model: "claude-opus-4-6-20250115",
    ...overrides,
  }
}

function makeSession(turnCount = 3, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session",
    version: "1.0",
    gitBranch: "main",
    cwd: "/project",
    slug: "test",
    model: "claude-opus-4-6-20250115",
    turns: Array.from({ length: turnCount }, () => makeTurn()),
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount,
    },
    rawMessages: [],
    ...overrides,
  }
}

function makeSource(): SessionSource {
  return { dirName: "test-dir", fileName: "test.jsonl", rawText: "" }
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    id: "branch-1",
    createdAt: "2025-01-15T10:00:00Z",
    branchPointTurnIndex: 1,
    label: "test branch",
    turns: [
      {
        index: 2,
        userMessage: "archived message",
        toolCalls: [],
        thinkingBlocks: [],
        assistantText: ["archived response"],
        timestamp: "2025-01-15T10:00:00Z",
        model: "claude-opus-4-6-20250115",
      },
    ],
    jsonlLines: ['{"type":"user","message":{"role":"user","content":"archived"}}'],
    ...overrides,
  }
}

function makeUndoState(overrides: Partial<UndoState> = {}): UndoState {
  return {
    sessionId: "test-session",
    currentTurnIndex: 2,
    totalTurns: 3,
    branches: [],
    activeBranchId: null,
    ...overrides,
  }
}

function setupMockFetch(undoStateResponse: UndoState | null = null) {
  mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/api/undo-state/")) {
      return new Response(
        undoStateResponse ? JSON.stringify(undoStateResponse) : "null",
        { status: undoStateResponse ? 200 : 404 }
      )
    }
    if (url.includes("/api/undo/apply")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes("/api/undo/truncate-jsonl")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes("/api/undo/append-jsonl")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes("/api/sessions/")) {
      return new Response("line1\nline2\nline3", { status: 200 })
    }
    return new Response("not found", { status: 404 })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setupMockFetch()
})

// ── Initial State ───────────────────────────────────────────────────────

describe("useUndoRedo", () => {
  describe("initial state", () => {
    it("starts with null undoState when no session", () => {
      const { result } = renderHook(() =>
        useUndoRedo(null, null, vi.fn())
      )
      expect(result.current.undoState).toBeNull()
      expect(result.current.canRedo).toBe(false)
      expect(result.current.redoTurnCount).toBe(0)
      expect(result.current.redoGhostTurns).toEqual([])
      expect(result.current.branches).toEqual([])
      expect(result.current.confirmState).toBeNull()
      expect(result.current.isApplying).toBe(false)
      expect(result.current.applyError).toBeNull()
    })

    it("fetches undo state when session is provided", async () => {
      const session = makeSession()
      const undoState = makeUndoState()
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })
      expect(result.current.undoState?.sessionId).toBe("test-session")
    })

    it("does not re-fetch when session ID is the same", async () => {
      const session = makeSession()
      const undoState = makeUndoState()
      setupMockFetch(undoState)

      const { result, rerender } = renderHook(
        ({ s }) => useUndoRedo(s, makeSource(), vi.fn()),
        { initialProps: { s: session } }
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })

      const fetchCount = mockAuthFetch.mock.calls.filter(
        (c) => (c[0] as string).includes("/api/undo-state/")
      ).length

      // Rerender with same session ID
      rerender({ s: session })

      const fetchCountAfter = mockAuthFetch.mock.calls.filter(
        (c) => (c[0] as string).includes("/api/undo-state/")
      ).length
      expect(fetchCountAfter).toBe(fetchCount)
    })

    it("sets undoState to null when fetch returns non-ok", async () => {
      const session = makeSession()
      mockAuthFetch.mockResolvedValueOnce(
        new Response("not found", { status: 404 })
      )

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        // Should remain null after failed fetch
        expect(result.current.undoState).toBeNull()
      })
    })

    it("clears undo state when session becomes null", async () => {
      const session = makeSession()
      const undoState = makeUndoState()
      setupMockFetch(undoState)

      const { result, rerender } = renderHook(
        ({ s }) => useUndoRedo(s, s ? makeSource() : null, vi.fn()),
        { initialProps: { s: session as ParsedSession | null } }
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })

      rerender({ s: null })
      expect(result.current.undoState).toBeNull()
    })
  })

  // ── canRedo / redoTurnCount ─────────────────────────────────────────

  describe("canRedo", () => {
    it("returns false when no branches exist", () => {
      const session = makeSession(3)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )
      expect(result.current.canRedo).toBe(false)
      expect(result.current.redoTurnCount).toBe(0)
    })

    it("returns true when branch point + 1 equals session turn count", async () => {
      const session = makeSession(2)
      const branch = makeBranch({ branchPointTurnIndex: 1 })
      const undoState = makeUndoState({
        branches: [branch],
        currentTurnIndex: 1,
        totalTurns: 2,
      })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })
      expect(result.current.canRedo).toBe(true)
      expect(result.current.redoTurnCount).toBe(1)
    })

    it("returns false when user has added turns since undo", async () => {
      const session = makeSession(5)
      const branch = makeBranch({ branchPointTurnIndex: 1 })
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })
      // branchPointTurnIndex + 1 = 2, session turns = 5, so canRedo is false
      expect(result.current.canRedo).toBe(false)
    })
  })

  // ── branches / branchesAtTurn ───────────────────────────────────────

  describe("branches", () => {
    it("returns empty array when no undo state", () => {
      const { result } = renderHook(() =>
        useUndoRedo(null, null, vi.fn())
      )
      expect(result.current.branches).toEqual([])
    })

    it("returns branches from undo state", async () => {
      const session = makeSession()
      const branch = makeBranch()
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(1)
      })
    })

    it("branchesAtTurn filters by turn index", async () => {
      const session = makeSession()
      const b1 = makeBranch({ id: "b1", branchPointTurnIndex: 1 })
      const b2 = makeBranch({ id: "b2", branchPointTurnIndex: 2 })
      const b3 = makeBranch({ id: "b3", branchPointTurnIndex: 1 })
      const undoState = makeUndoState({ branches: [b1, b2, b3] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(3)
      })

      const atTurn1 = result.current.branchesAtTurn(1)
      expect(atTurn1).toHaveLength(2)
      expect(atTurn1.map((b) => b.id)).toEqual(["b1", "b3"])

      const atTurn2 = result.current.branchesAtTurn(2)
      expect(atTurn2).toHaveLength(1)
      expect(atTurn2[0].id).toBe("b2")

      const atTurn0 = result.current.branchesAtTurn(0)
      expect(atTurn0).toHaveLength(0)
    })
  })

  // ── requestUndo ───────────────────────────────────────────────────────

  describe("requestUndo", () => {
    it("does nothing when session is null", () => {
      const { result } = renderHook(() =>
        useUndoRedo(null, null, vi.fn())
      )
      act(() => result.current.requestUndo(1))
      expect(result.current.confirmState).toBeNull()
    })

    it("sets confirmState for valid undo request", async () => {
      const session = makeSession(5)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      // Wait for the initial undo-state fetch to settle
      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.type).toBe("undo")
      // targetTurnIndex is action.targetTurnIndex - 1
      expect(result.current.confirmState?.targetTurnIndex).toBe(2)
    })

    it("calls buildUndoOperations to compute ops", async () => {
      const session = makeSession(5)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))
      expect(mockBuildUndo).toHaveBeenCalledWith(
        session.turns,
        4, // session.turns.length - 1
        2  // targetTurnIndex - 1
      )
    })

    it("ignores undo request that would keep all turns", async () => {
      const session = makeSession(5)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      // targetTurnIndex - 1 = 4 which is >= session.turns.length - 1 (4)
      act(() => result.current.requestUndo(5))
      expect(result.current.confirmState).toBeNull()
    })

    it("ignores undo request with negative effective target", async () => {
      const session = makeSession(3)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      // targetTurnIndex - 1 = -2, which is < -1
      act(() => result.current.requestUndo(-1))
      expect(result.current.confirmState).toBeNull()
    })

    it("allows undo to target index 0 (keep only first turn)", async () => {
      const session = makeSession(5)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      // targetTurnIndex 1 => effectiveTarget = 0
      act(() => result.current.requestUndo(1))
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.targetTurnIndex).toBe(0)
    })

    it("allows undo to target index -1 (remove all turns)", async () => {
      const session = makeSession(3)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      // targetTurnIndex 0 => effectiveTarget = -1 (remove all turns)
      act(() => result.current.requestUndo(0))
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.targetTurnIndex).toBe(-1)
    })
  })

  // ── requestRedoAll ────────────────────────────────────────────────────

  describe("requestRedoAll", () => {
    it("does nothing when canRedo is false", () => {
      const session = makeSession(3)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      act(() => result.current.requestRedoAll())
      expect(result.current.confirmState).toBeNull()
    })

    it("sets confirmState when redo is available", async () => {
      const session = makeSession(2)
      const branch = makeBranch({ branchPointTurnIndex: 1 })
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.canRedo).toBe(true)
      })

      act(() => result.current.requestRedoAll())
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.type).toBe("redo")
      expect(result.current.confirmState?.branchId).toBe("branch-1")
    })
  })

  // ── requestRedoUpTo ───────────────────────────────────────────────────

  describe("requestRedoUpTo", () => {
    it("does nothing when canRedo is false", () => {
      const session = makeSession(3)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )
      act(() => result.current.requestRedoUpTo(0))
      expect(result.current.confirmState).toBeNull()
    })

    it("sets confirmState with partial redo info", async () => {
      const session = makeSession(2)
      const branch = makeBranch({
        branchPointTurnIndex: 1,
        turns: [
          {
            index: 2,
            userMessage: "msg1",
            toolCalls: [],
            thinkingBlocks: [],
            assistantText: ["r1"],
            timestamp: "",
            model: null,
          },
          {
            index: 3,
            userMessage: "msg2",
            toolCalls: [],
            thinkingBlocks: [],
            assistantText: ["r2"],
            timestamp: "",
            model: null,
          },
        ],
      })
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.canRedo).toBe(true)
      })

      act(() => result.current.requestRedoUpTo(0))
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.type).toBe("redo")
      expect(result.current.confirmState?.redoUpToArchiveIndex).toBe(0)
      // targetTurnIndex = branchPointTurnIndex + turnCount = 1 + 1 = 2
      expect(result.current.confirmState?.targetTurnIndex).toBe(2)
    })
  })

  // ── requestBranchSwitch ───────────────────────────────────────────────

  describe("requestBranchSwitch", () => {
    it("does nothing when session is null", () => {
      const { result } = renderHook(() =>
        useUndoRedo(null, null, vi.fn())
      )
      act(() => result.current.requestBranchSwitch("branch-1"))
      expect(result.current.confirmState).toBeNull()
    })

    it("does nothing when branch is not found", async () => {
      const session = makeSession()
      const undoState = makeUndoState({ branches: [] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.undoState).not.toBeNull()
      })

      act(() => result.current.requestBranchSwitch("nonexistent"))
      expect(result.current.confirmState).toBeNull()
    })

    it("sets confirmState for valid branch switch", async () => {
      const session = makeSession(3)
      const branch = makeBranch({ id: "b1", branchPointTurnIndex: 1 })
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(1)
      })

      act(() => result.current.requestBranchSwitch("b1"))
      expect(result.current.confirmState).not.toBeNull()
      expect(result.current.confirmState?.type).toBe("branch-switch")
      expect(result.current.confirmState?.branchId).toBe("b1")
      expect(result.current.confirmState?.targetTurnIndex).toBe(1)
    })

    it("accepts optional archiveTurnIndex", async () => {
      const session = makeSession(3)
      const branch = makeBranch({
        id: "b1",
        branchPointTurnIndex: 0,
        turns: [
          { index: 1, userMessage: "m1", toolCalls: [], thinkingBlocks: [], assistantText: [], timestamp: "", model: null },
          { index: 2, userMessage: "m2", toolCalls: [], thinkingBlocks: [], assistantText: [], timestamp: "", model: null },
        ],
      })
      const undoState = makeUndoState({ branches: [branch] })
      setupMockFetch(undoState)

      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(result.current.branches).toHaveLength(1)
      })

      act(() => result.current.requestBranchSwitch("b1", 0))
      expect(result.current.confirmState?.branchTurnIndex).toBe(0)
    })
  })

  // ── confirmCancel ─────────────────────────────────────────────────────

  describe("confirmCancel", () => {
    it("clears confirmState and applyError", async () => {
      const session = makeSession(5)
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))
      expect(result.current.confirmState).not.toBeNull()

      act(() => result.current.confirmCancel())
      expect(result.current.confirmState).toBeNull()
      expect(result.current.applyError).toBeNull()
    })
  })

  // ── confirmApply ──────────────────────────────────────────────────────

  describe("confirmApply", () => {
    it("clears confirmState when session or source is null", async () => {
      const { result } = renderHook(() =>
        useUndoRedo(null, null, vi.fn())
      )

      await act(async () => {
        await result.current.confirmApply()
      })
      expect(result.current.confirmState).toBeNull()
    })

    it("clears confirmState when there is no pending confirm", async () => {
      const session = makeSession()
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )

      await act(async () => {
        await result.current.confirmApply()
      })
      expect(result.current.isApplying).toBe(false)
    })

    it("calls onReloadSession after successful undo apply", async () => {
      const session = makeSession(5)
      const source = makeSource()
      const onReload = vi.fn().mockResolvedValue(undefined)

      const { result } = renderHook(() =>
        useUndoRedo(session, source, onReload)
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))
      expect(result.current.confirmState).not.toBeNull()

      await act(async () => {
        await result.current.confirmApply()
      })

      expect(onReload).toHaveBeenCalled()
      expect(result.current.confirmState).toBeNull()
      expect(result.current.isApplying).toBe(false)
    })

    it("sets applyError when file operation fails", async () => {
      const session = makeSession(5)
      const source = makeSource()
      const onReload = vi.fn().mockResolvedValue(undefined)

      // Make buildUndoOperations return ops for BOTH calls (requestUndo + confirmApply)
      mockBuildUndo.mockReturnValue([
        { type: "revert-edit", filePath: "a.ts", oldString: "new", newString: "old" },
      ] as FileOperation[])
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/undo-state/")) {
          return new Response("null", { status: 404 })
        }
        if (url.includes("/api/sessions/")) {
          return new Response("line1\nline2", { status: 200 })
        }
        if (url.includes("/api/undo/apply")) {
          return new Response(JSON.stringify({ error: "File not found" }), { status: 500 })
        }
        return new Response("ok", { status: 200 })
      })

      const { result } = renderHook(() =>
        useUndoRedo(session, source, onReload)
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))

      await act(async () => {
        await result.current.confirmApply()
      })

      expect(result.current.applyError).toBe("File not found")
      expect(onReload).not.toHaveBeenCalled()

      // Reset to default
      mockBuildUndo.mockReturnValue([])
    })

    it("sets applyError when session file read fails", async () => {
      const session = makeSession(5)
      const source = makeSource()
      const onReload = vi.fn().mockResolvedValue(undefined)

      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/undo-state/")) {
          return new Response("null", { status: 404 })
        }
        if (url.includes("/api/sessions/")) {
          return new Response("not found", { status: 404 })
        }
        return new Response("ok", { status: 200 })
      })

      const { result } = renderHook(() =>
        useUndoRedo(session, source, onReload)
      )

      await waitFor(() => {
        expect(mockAuthFetch).toHaveBeenCalled()
      })

      act(() => result.current.requestUndo(3))

      await act(async () => {
        await result.current.confirmApply()
      })

      expect(result.current.applyError).toBe("Failed to read session file")
    })
  })

  // ── redoGhostTurns ───────────────────────────────────────────────────

  describe("redoGhostTurns", () => {
    it("returns empty array when no redo branch", () => {
      const session = makeSession()
      const { result } = renderHook(() =>
        useUndoRedo(session, makeSource(), vi.fn())
      )
      expect(result.current.redoGhostTurns).toEqual([])
    })
  })
})
