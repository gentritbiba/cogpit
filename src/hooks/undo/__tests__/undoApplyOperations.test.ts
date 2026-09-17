import { describe, it, expect } from "vitest"
import { applyRedo, type UndoTransaction } from "@/hooks/undo/undoApplyOperations"
import { archiveTurn } from "@/lib/undo-engine"
import { makeTurn } from "@/__tests__/fixtures"
import type { Branch, UndoState } from "../../../../shared/session/types"
import type { SessionSource } from "@/hooks/useLiveSession"

const source = { dirName: "-Users-me-project", fileName: "s.jsonl" } as SessionSource

function turnLines(uuid: string): string[] {
  return [
    JSON.stringify({ type: "user", uuid, message: { role: "user", content: `prompt ${uuid}` } }),
    JSON.stringify({ type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ]
}

function branch(overrides: Partial<Branch>): Branch {
  return {
    id: "b",
    createdAt: "2025-01-15T10:00:00Z",
    branchPointTurnIndex: 0,
    label: "b",
    turns: [],
    jsonlLines: [],
    ...overrides,
  }
}

describe("applyRedo", () => {
  // Three archived turns after loaded turn 4; a child forks from the second.
  const child = branch({ id: "child", branchPointTurnIndex: 99, branchPointTurnId: "u-6" })
  const parent = branch({
    id: "parent",
    branchPointTurnIndex: 4,
    branchPointTurnId: "u-4",
    turns: ["u-5", "u-6", "u-7"].map((id, i) => archiveTurn(makeTurn({ id, userMessage: `prompt ${id}` }), 5 + i)),
    jsonlLines: ["u-5", "u-6", "u-7"].flatMap(turnLines),
    childBranches: [child],
  })
  const state: UndoState = { sessionId: "s", branches: [parent], activeBranchId: null }

  async function redo(upTo?: number): Promise<UndoTransaction> {
    let committed: UndoTransaction | undefined
    await applyRedo(
      { type: "redo", summary: { turnCount: 0, fileCount: 0, filePaths: [], operationCount: 0 }, targetTurnIndex: 0, branchId: "parent", redoUpToArchiveIndex: upTo },
      source,
      state,
      parent,
      "kept\n",
      async (transaction) => { committed = transaction },
    )
    return committed!
  }

  it("restores part of a branch and re-anchors what is left to the last restored turn", async () => {
    const { sessionMutation, state: next } = await redo(0)
    expect(sessionMutation).toEqual({ type: "append", lines: turnLines("u-5"), expectedLineCount: 1 })
    expect(next.branches).toHaveLength(1)
    expect(next.branches[0]).toMatchObject({
      id: "parent",
      branchPointTurnIndex: 5,
      branchPointTurnId: "u-5",
      label: "prompt u-6",
    })
    expect(next.branches[0].turns.map((turn) => turn.id)).toEqual(["u-6", "u-7"])
    // The child forks from u-6, which is still archived.
    expect(next.branches[0].childBranches?.map((b) => b.id)).toEqual(["child"])
  })

  it("releases a child once the turn it forks from is restored", async () => {
    const { state: next } = await redo(1)
    expect(next.branches.map((b) => [b.id, b.branchPointTurnIndex])).toEqual([["parent", 6], ["child", 6]])
    expect(next.branches[0].childBranches).toBeUndefined()
  })

  it("replaces a fully restored branch with its children", async () => {
    const { sessionMutation, state: next } = await redo()
    expect(sessionMutation).toMatchObject({ type: "append", lines: parent.jsonlLines })
    expect(next.branches.map((b) => b.id)).toEqual(["child"])
  })
})
