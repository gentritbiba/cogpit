import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  extractReversibleCalls,
  archiveTurn,
  buildUndoOperations,
  buildRedoOperations,
  buildRedoFromArchived,
  createBranch,
  collectChildBranches,
  splitChildBranches,
  summarizeOperations,
  createEmptyUndoState,
} from "@/lib/undo-engine"
import type { FileOperation } from "@/lib/undo-engine"
import type { Branch, ArchivedTurn } from "@/lib/types"
import {
  makeTurn,
  makeEditToolCall,
  makeWriteToolCall,
  makeToolCall,
  resetFixtureCounter,
} from "@/__tests__/fixtures"

beforeEach(() => {
  resetFixtureCounter()
})

// ── extractReversibleCalls ────────────────────────────────────────────────

describe("extractReversibleCalls", () => {
  it("returns empty array for turn with no tool calls", () => {
    const turn = makeTurn({ toolCalls: [] })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("extracts Edit tool calls", () => {
    const turn = makeTurn({
      toolCalls: [makeEditToolCall("src/app.ts", "old", "new")],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      type: "Edit",
      filePath: "src/app.ts",
      oldString: "old",
      newString: "new",
      replaceAll: false,
    })
  })

  it("extracts Write tool calls", () => {
    const turn = makeTurn({
      toolCalls: [makeWriteToolCall("src/new.ts", "file content")],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      type: "Write",
      filePath: "src/new.ts",
      content: "file content",
    })
  })

  it("skips non-reversible tool calls (Read, Bash, etc.)", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({ name: "Read", input: { file_path: "test.ts" } }),
        makeToolCall({ name: "Bash", input: { command: "ls" } }),
        makeToolCall({ name: "Grep", input: { pattern: "foo" } }),
      ],
    })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("skips error tool calls", () => {
    const turn = makeTurn({
      toolCalls: [makeEditToolCall("src/app.ts", "old", "new", { isError: true })],
    })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("extracts multiple reversible calls from one turn", () => {
    const turn = makeTurn({
      toolCalls: [
        makeEditToolCall("a.ts", "a1", "a2"),
        makeWriteToolCall("b.ts", "content-b"),
        makeEditToolCall("c.ts", "c1", "c2"),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(3)
    expect(calls[0].type).toBe("Edit")
    expect(calls[1].type).toBe("Write")
    expect(calls[2].type).toBe("Edit")
  })

  it("handles Edit with replace_all flag", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Edit",
          input: { file_path: "x.ts", old_string: "a", new_string: "b", replace_all: true },
        }),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls[0].replaceAll).toBe(true)
  })

  it("skips Edit calls with missing file_path", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Edit",
          input: { old_string: "a", new_string: "b" },
        }),
      ],
    })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("skips Write calls with missing file_path", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Write",
          input: { content: "stuff" },
        }),
      ],
    })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("uses path fallback when file_path is missing", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Edit",
          input: { path: "fallback.ts", old_string: "a", new_string: "b" },
        }),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0].filePath).toBe("fallback.ts")
  })

  it("uses path fallback for Write when file_path is missing", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Write",
          input: { path: "legacy-write.ts", content: "data" },
        }),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0].filePath).toBe("legacy-write.ts")
    expect(calls[0].content).toBe("data")
  })

  it("handles empty toolCalls array", () => {
    const turn = makeTurn({ toolCalls: [] })
    expect(extractReversibleCalls(turn)).toEqual([])
  })

  it("extracts Edit with replaceAll: true correctly", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Edit",
          input: { file_path: "bulk.ts", old_string: "foo", new_string: "bar", replace_all: true },
        }),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      type: "Edit",
      filePath: "bulk.ts",
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    })
  })

  it("prefers file_path over path when both are present", () => {
    const turn = makeTurn({
      toolCalls: [
        makeToolCall({
          name: "Edit",
          input: { file_path: "preferred.ts", path: "fallback.ts", old_string: "a", new_string: "b" },
        }),
      ],
    })
    const calls = extractReversibleCalls(turn)
    expect(calls[0].filePath).toBe("preferred.ts")
  })
})

// ── archiveTurn ───────────────────────────────────────────────────────────

describe("archiveTurn", () => {
  it("archives a turn with correct structure", () => {
    const turn = makeTurn({
      userMessage: "Please edit the file",
      toolCalls: [makeEditToolCall("a.ts", "old", "new")],
      thinking: [{ type: "thinking", thinking: "Let me think", signature: "sig" }],
      assistantText: ["Done editing"],
      timestamp: "2025-01-15T10:00:00Z",
      model: "claude-opus-4-6-20250115",
    })
    const archived = archiveTurn(turn, 3)
    expect(archived.index).toBe(3)
    expect(archived.userMessage).toBe("Please edit the file")
    expect(archived.toolCalls).toHaveLength(1)
    expect(archived.thinkingBlocks).toEqual(["Let me think"])
    expect(archived.assistantText).toEqual(["Done editing"])
    expect(archived.timestamp).toBe("2025-01-15T10:00:00Z")
    expect(archived.model).toBe("claude-opus-4-6-20250115")
  })

  it("archives a turn with no tool calls", () => {
    const turn = makeTurn({ toolCalls: [] })
    const archived = archiveTurn(turn, 0)
    expect(archived.toolCalls).toEqual([])
  })

  it("handles null userMessage", () => {
    const turn = makeTurn({ userMessage: null })
    const archived = archiveTurn(turn, 0)
    expect(archived.userMessage).toBe("")
  })
})

// ── buildUndoOperations ───────────────────────────────────────────────────

describe("buildUndoOperations", () => {
  it("returns empty array when from equals to", () => {
    const turns = [makeTurn(), makeTurn()]
    expect(buildUndoOperations(turns, 1, 1)).toEqual([])
  })

  it("builds reverse-edit operations for Edit calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeEditToolCall("a.ts", "old", "new")] }),
    ]
    const ops = buildUndoOperations(turns, 1, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      type: "reverse-edit",
      filePath: "a.ts",
      oldString: "new",   // swapped
      newString: "old",   // swapped
      turnIndex: 1,
    })
  })

  it("builds delete-write operations for Write calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeWriteToolCall("b.ts", "content")] }),
    ]
    const ops = buildUndoOperations(turns, 1, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      type: "delete-write",
      filePath: "b.ts",
      content: "content",
      turnIndex: 1,
    })
  })

  it("reverses operations within a turn (last call first)", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({
        toolCalls: [
          makeEditToolCall("a.ts", "a1", "a2"),
          makeEditToolCall("b.ts", "b1", "b2"),
        ],
      }),
    ]
    const ops = buildUndoOperations(turns, 1, 0)
    expect(ops).toHaveLength(2)
    // b.ts should come first (reversed order)
    expect(ops[0].filePath).toBe("b.ts")
    expect(ops[1].filePath).toBe("a.ts")
  })

  it("processes multiple turns in reverse order", () => {
    const turns = [
      makeTurn({ toolCalls: [] }), // turn 0 - target
      makeTurn({ toolCalls: [makeEditToolCall("a.ts", "a1", "a2")] }), // turn 1
      makeTurn({ toolCalls: [makeEditToolCall("b.ts", "b1", "b2")] }), // turn 2
    ]
    const ops = buildUndoOperations(turns, 2, 0)
    expect(ops).toHaveLength(2)
    // turn 2 first, then turn 1
    expect(ops[0].filePath).toBe("b.ts")
    expect(ops[1].filePath).toBe("a.ts")
  })

  it("skips turns with no reversible calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeToolCall({ name: "Read" })] }),
      makeTurn({ toolCalls: [makeEditToolCall("a.ts", "old", "new")] }),
    ]
    const ops = buildUndoOperations(turns, 2, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0].filePath).toBe("a.ts")
  })

  it("preserves replaceAll flag in undo operations", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({
        toolCalls: [
          makeToolCall({
            name: "Edit",
            input: { file_path: "bulk.ts", old_string: "foo", new_string: "bar", replace_all: true },
          }),
        ],
      }),
    ]
    const ops = buildUndoOperations(turns, 1, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0].replaceAll).toBe(true)
    // Swapped strings for undo
    expect(ops[0].oldString).toBe("bar")
    expect(ops[0].newString).toBe("foo")
  })

  it("handles undoing multiple turns with mixed Edit and Write calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({
        toolCalls: [
          makeEditToolCall("a.ts", "a1", "a2"),
          makeWriteToolCall("new.ts", "content"),
        ],
      }),
      makeTurn({
        toolCalls: [makeEditToolCall("b.ts", "b1", "b2")],
      }),
    ]
    const ops = buildUndoOperations(turns, 2, 0)
    expect(ops).toHaveLength(3)
    // Turn 2 first (reverse), then turn 1 (reverse within)
    expect(ops[0]).toMatchObject({ type: "reverse-edit", filePath: "b.ts" })
    expect(ops[1]).toMatchObject({ type: "delete-write", filePath: "new.ts" })
    expect(ops[2]).toMatchObject({ type: "reverse-edit", filePath: "a.ts" })
  })
})

// ── buildRedoOperations ───────────────────────────────────────────────────

describe("buildRedoOperations", () => {
  it("returns empty array when from equals to", () => {
    const turns = [makeTurn(), makeTurn()]
    expect(buildRedoOperations(turns, 1, 1)).toEqual([])
  })

  it("builds apply-edit operations for Edit calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeEditToolCall("a.ts", "old", "new")] }),
    ]
    const ops = buildRedoOperations(turns, 0, 1)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      type: "apply-edit",
      filePath: "a.ts",
      oldString: "old",
      newString: "new",
      turnIndex: 1,
    })
  })

  it("builds create-write operations for Write calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeWriteToolCall("b.ts", "content")] }),
    ]
    const ops = buildRedoOperations(turns, 0, 1)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      type: "create-write",
      filePath: "b.ts",
      content: "content",
      turnIndex: 1,
    })
  })

  it("processes turns in forward order", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({ toolCalls: [makeEditToolCall("a.ts", "a1", "a2")] }),
      makeTurn({ toolCalls: [makeEditToolCall("b.ts", "b1", "b2")] }),
    ]
    const ops = buildRedoOperations(turns, 0, 2)
    expect(ops).toHaveLength(2)
    expect(ops[0].filePath).toBe("a.ts")
    expect(ops[1].filePath).toBe("b.ts")
  })

  it("preserves replaceAll flag", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({
        toolCalls: [
          makeToolCall({
            name: "Edit",
            input: { file_path: "x.ts", old_string: "a", new_string: "b", replace_all: true },
          }),
        ],
      }),
    ]
    const ops = buildRedoOperations(turns, 0, 1)
    expect(ops[0].replaceAll).toBe(true)
  })
})

// ── buildRedoFromArchived ─────────────────────────────────────────────────

describe("buildRedoFromArchived", () => {
  const archivedTurns: ArchivedTurn[] = [
    {
      index: 1,
      userMessage: "edit a",
      toolCalls: [{ type: "Edit", filePath: "a.ts", oldString: "a1", newString: "a2", replaceAll: false }],
      thinkingBlocks: [],
      assistantText: [],
      timestamp: "2025-01-15T10:00:00Z",
      model: "claude-opus-4-6",
    },
    {
      index: 2,
      userMessage: "write b",
      toolCalls: [{ type: "Write", filePath: "b.ts", content: "hello" }],
      thinkingBlocks: [],
      assistantText: [],
      timestamp: "2025-01-15T10:01:00Z",
      model: "claude-opus-4-6",
    },
    {
      index: 3,
      userMessage: "edit c",
      toolCalls: [{ type: "Edit", filePath: "c.ts", oldString: "c1", newString: "c2", replaceAll: false }],
      thinkingBlocks: [],
      assistantText: [],
      timestamp: "2025-01-15T10:02:00Z",
      model: "claude-opus-4-6",
    },
  ]

  it("builds redo operations for all archived turns", () => {
    const ops = buildRedoFromArchived(archivedTurns)
    expect(ops).toHaveLength(3)
    expect(ops[0]).toMatchObject({ type: "apply-edit", filePath: "a.ts" })
    expect(ops[1]).toMatchObject({ type: "create-write", filePath: "b.ts" })
    expect(ops[2]).toMatchObject({ type: "apply-edit", filePath: "c.ts" })
  })

  it("respects upToIndex limit", () => {
    const ops = buildRedoFromArchived(archivedTurns, 1)
    expect(ops).toHaveLength(2)
    expect(ops[0].filePath).toBe("a.ts")
    expect(ops[1].filePath).toBe("b.ts")
  })

  it("returns empty for empty archived turns", () => {
    expect(buildRedoFromArchived([])).toEqual([])
  })

  it("handles upToIndex of 0", () => {
    const ops = buildRedoFromArchived(archivedTurns, 0)
    expect(ops).toHaveLength(1)
    expect(ops[0].filePath).toBe("a.ts")
  })
})

// ── createBranch ──────────────────────────────────────────────────────────

describe("createBranch", () => {
  it("creates a branch from turns after the branch point", () => {
    const turns = [
      makeTurn({ userMessage: "first" }),
      makeTurn({ userMessage: "second", toolCalls: [makeEditToolCall("a.ts", "x", "y")] }),
      makeTurn({ userMessage: "third", toolCalls: [makeWriteToolCall("b.ts", "data")] }),
    ]
    // Mock crypto.randomUUID
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid-123" })

    const branch = createBranch(turns, 0, ["line1", "line2"])

    expect(branch.id).toBe("test-uuid-123")
    expect(branch.branchPointTurnIndex).toBe(0)
    expect(branch.turns).toHaveLength(2) // turns 1 and 2
    expect(branch.turns[0].userMessage).toBe("second")
    expect(branch.turns[1].userMessage).toBe("third")
    expect(branch.jsonlLines).toEqual(["line1", "line2"])
    expect(branch.childBranches).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it("truncates long labels to 60 chars", () => {
    const longMessage = "A".repeat(100)
    const turns = [
      makeTurn({}),
      makeTurn({ userMessage: longMessage }),
    ]
    vi.stubGlobal("crypto", { randomUUID: () => "uuid" })

    const branch = createBranch(turns, 0, [])
    expect(branch.label.length).toBeLessThanOrEqual(60)
    expect(branch.label).toContain("...")

    vi.unstubAllGlobals()
  })

  it("uses 'Untitled branch' when no user message exists", () => {
    const turns = [
      makeTurn({}),
      makeTurn({ userMessage: null, toolCalls: [] }),
    ]
    vi.stubGlobal("crypto", { randomUUID: () => "uuid" })

    const branch = createBranch(turns, 0, [])
    expect(branch.label).toBe("Untitled branch")

    vi.unstubAllGlobals()
  })

  it("includes child branches when provided", () => {
    const childBranch: Branch = {
      id: "child-1",
      createdAt: "2025-01-15T10:00:00Z",
      branchPointTurnIndex: 2,
      label: "child",
      turns: [],
      jsonlLines: [],
    }
    const turns = [makeTurn(), makeTurn()]
    vi.stubGlobal("crypto", { randomUUID: () => "uuid" })

    const branch = createBranch(turns, 0, [], [childBranch])
    expect(branch.childBranches).toEqual([childBranch])

    vi.unstubAllGlobals()
  })

  it("omits childBranches key when array is empty", () => {
    const turns = [makeTurn(), makeTurn()]
    vi.stubGlobal("crypto", { randomUUID: () => "uuid" })

    const branch = createBranch(turns, 0, [], [])
    expect(branch.childBranches).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it("creates branch with deeply nested child branches", () => {
    const grandchild: Branch = {
      id: "grandchild-1",
      createdAt: "2025-01-15T10:00:00Z",
      branchPointTurnIndex: 4,
      label: "grandchild",
      turns: [],
      jsonlLines: [],
    }
    const child: Branch = {
      id: "child-1",
      createdAt: "2025-01-15T10:00:00Z",
      branchPointTurnIndex: 3,
      label: "child with nested",
      turns: [],
      jsonlLines: [],
      childBranches: [grandchild],
    }
    const turns = [makeTurn(), makeTurn({ userMessage: "branched" })]
    vi.stubGlobal("crypto", { randomUUID: () => "nested-uuid" })

    const branch = createBranch(turns, 0, [], [child])
    expect(branch.childBranches).toHaveLength(1)
    expect(branch.childBranches![0].childBranches).toHaveLength(1)
    expect(branch.childBranches![0].childBranches![0].id).toBe("grandchild-1")

    vi.unstubAllGlobals()
  })

  it("archives turns correctly with multiple tool calls", () => {
    const turns = [
      makeTurn({ toolCalls: [] }),
      makeTurn({
        userMessage: "Multiple edits",
        toolCalls: [
          makeEditToolCall("a.ts", "a1", "a2"),
          makeWriteToolCall("b.ts", "content"),
          makeEditToolCall("c.ts", "c1", "c2"),
        ],
      }),
      makeTurn({
        userMessage: "More work",
        toolCalls: [makeEditToolCall("d.ts", "d1", "d2")],
      }),
    ]
    vi.stubGlobal("crypto", { randomUUID: () => "multi-uuid" })

    const branch = createBranch(turns, 0, [])
    expect(branch.turns).toHaveLength(2)
    expect(branch.turns[0].toolCalls).toHaveLength(3)
    expect(branch.turns[1].toolCalls).toHaveLength(1)

    vi.unstubAllGlobals()
  })
})

// ── collectChildBranches ──────────────────────────────────────────────────

describe("collectChildBranches", () => {
  const branches: Branch[] = [
    { id: "b1", createdAt: "", branchPointTurnIndex: 1, label: "b1", turns: [], jsonlLines: [] },
    { id: "b2", createdAt: "", branchPointTurnIndex: 3, label: "b2", turns: [], jsonlLines: [] },
    { id: "b3", createdAt: "", branchPointTurnIndex: 5, label: "b3", turns: [], jsonlLines: [] },
    { id: "b4", createdAt: "", branchPointTurnIndex: 2, label: "b4", turns: [], jsonlLines: [] },
  ]

  it("splits branches at cutoff point", () => {
    const { retained, scooped } = collectChildBranches(branches, 3)
    expect(retained.map((b) => b.id)).toEqual(["b1", "b2", "b4"])
    expect(scooped.map((b) => b.id)).toEqual(["b3"])
  })

  it("retains all branches when cutoff is high", () => {
    const { retained, scooped } = collectChildBranches(branches, 10)
    expect(retained).toHaveLength(4)
    expect(scooped).toHaveLength(0)
  })

  it("scoops all branches when cutoff is 0", () => {
    const { retained, scooped } = collectChildBranches(branches, 0)
    expect(retained).toHaveLength(0)
    expect(scooped).toHaveLength(4)
  })

  it("handles empty branch list", () => {
    const { retained, scooped } = collectChildBranches([], 5)
    expect(retained).toEqual([])
    expect(scooped).toEqual([])
  })

  it("keeps branches exactly at cutoff in retained", () => {
    const { retained, scooped } = collectChildBranches(branches, 2)
    // b1 (1), b4 (2) retained; b2 (3), b3 (5) scooped
    expect(retained.map((b) => b.id)).toEqual(["b1", "b4"])
    expect(scooped.map((b) => b.id)).toEqual(["b2", "b3"])
  })
})

// ── splitChildBranches ────────────────────────────────────────────────────

describe("splitChildBranches", () => {
  const childBranches: Branch[] = [
    { id: "c1", createdAt: "", branchPointTurnIndex: 2, label: "c1", turns: [], jsonlLines: [] },
    { id: "c2", createdAt: "", branchPointTurnIndex: 5, label: "c2", turns: [], jsonlLines: [] },
    { id: "c3", createdAt: "", branchPointTurnIndex: 8, label: "c3", turns: [], jsonlLines: [] },
  ]

  it("splits based on parentBranchPoint + redoTurnCount", () => {
    // maxValidIndex = 1 + 4 = 5
    const { restored, remaining } = splitChildBranches(childBranches, 1, 4)
    expect(restored.map((b) => b.id)).toEqual(["c1", "c2"])
    expect(remaining.map((b) => b.id)).toEqual(["c3"])
  })

  it("restores all when redoTurnCount covers everything", () => {
    const { restored, remaining } = splitChildBranches(childBranches, 0, 100)
    expect(restored).toHaveLength(3)
    expect(remaining).toHaveLength(0)
  })

  it("keeps all remaining when redoTurnCount is 0", () => {
    // maxValidIndex = 0 + 0 = 0
    const { restored, remaining } = splitChildBranches(childBranches, 0, 0)
    expect(restored).toHaveLength(0)
    expect(remaining).toHaveLength(3)
  })

  it("handles empty child branches", () => {
    const { restored, remaining } = splitChildBranches([], 0, 10)
    expect(restored).toEqual([])
    expect(remaining).toEqual([])
  })
})

// ── summarizeOperations ───────────────────────────────────────────────────

describe("summarizeOperations", () => {
  it("returns zero counts for empty operations", () => {
    const summary = summarizeOperations([])
    expect(summary).toEqual({
      turnCount: 0,
      fileCount: 0,
      filePaths: [],
      operationCount: 0,
    })
  })

  it("counts unique turns and files", () => {
    const ops: FileOperation[] = [
      { type: "reverse-edit", filePath: "a.ts", oldString: "x", newString: "y", turnIndex: 1 },
      { type: "reverse-edit", filePath: "b.ts", oldString: "x", newString: "y", turnIndex: 1 },
      { type: "delete-write", filePath: "a.ts", content: "c", turnIndex: 2 },
    ]
    const summary = summarizeOperations(ops)
    expect(summary.turnCount).toBe(2)      // turns 1 and 2
    expect(summary.fileCount).toBe(2)      // a.ts and b.ts
    expect(summary.operationCount).toBe(3) // 3 operations
    expect(summary.filePaths).toContain("a.ts")
    expect(summary.filePaths).toContain("b.ts")
  })

  it("deduplicates file paths", () => {
    const ops: FileOperation[] = [
      { type: "reverse-edit", filePath: "a.ts", oldString: "x", newString: "y", turnIndex: 1 },
      { type: "reverse-edit", filePath: "a.ts", oldString: "p", newString: "q", turnIndex: 2 },
    ]
    const summary = summarizeOperations(ops)
    expect(summary.fileCount).toBe(1)
    expect(summary.filePaths).toEqual(["a.ts"])
  })

  it("counts single operation correctly", () => {
    const ops: FileOperation[] = [
      { type: "create-write", filePath: "new.ts", content: "hello", turnIndex: 5 },
    ]
    const summary = summarizeOperations(ops)
    expect(summary.turnCount).toBe(1)
    expect(summary.fileCount).toBe(1)
    expect(summary.operationCount).toBe(1)
  })
})

// ── createEmptyUndoState ──────────────────────────────────────────────────

describe("createEmptyUndoState", () => {
  it("creates state with correct defaults", () => {
    const state = createEmptyUndoState("session-123", 5)
    expect(state).toEqual({
      sessionId: "session-123",
      currentTurnIndex: 4,  // totalTurns - 1
      totalTurns: 5,
      branches: [],
      activeBranchId: null,
    })
  })

  it("handles single turn", () => {
    const state = createEmptyUndoState("s1", 1)
    expect(state.currentTurnIndex).toBe(0)
    expect(state.totalTurns).toBe(1)
  })

  it("handles zero turns (edge case)", () => {
    const state = createEmptyUndoState("s1", 0)
    expect(state.currentTurnIndex).toBe(-1)
    expect(state.totalTurns).toBe(0)
  })
})
