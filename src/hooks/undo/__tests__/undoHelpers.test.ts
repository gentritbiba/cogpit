import { describe, it, expect } from "vitest"
import { buildSummary, resolveUndoCut } from "@/hooks/undo/undoHelpers"
import { makeTurn } from "@/__tests__/fixtures"
import { formatFor } from "../../../../shared/session/agents"

const DIR = "-Users-me-project"

function userLine(uuid: string, text: string): string {
  return JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } })
}

function assistantLine(uuid: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  })
}

// Five turns on disk; the client has only the last two loaded.
const lines = ["u-1", "u-2", "u-3", "u-4", "u-5"].flatMap((uuid) => [
  userLine(uuid, `prompt ${uuid}`),
  assistantLine(`a-${uuid}`),
])

describe("resolveUndoCut", () => {
  it("cuts after the last kept turn and anchors the branch to it", () => {
    const cut = resolveUndoCut(lines, makeTurn({ id: "u-4" }), makeTurn({ id: "u-5" }), 1, 2, DIR)
    expect(cut).toEqual({ cutoffLine: 8, branchPointTurnId: "u-4" })
  })

  it("keeps the unloaded turns when undoing from the first loaded turn", () => {
    // Window index 0 is file turn 4: there is no loaded turn to keep, and an
    // index cut of "keep 0 turns" would empty the whole transcript.
    const cut = resolveUndoCut(lines, undefined, makeTurn({ id: "u-4" }), 0, 2, DIR)
    expect(cut).toEqual({ cutoffLine: 6, branchPointTurnId: "u-3" })
  })

  it("anchors to nothing when the transcript's very first turn is undone", () => {
    const cut = resolveUndoCut(lines, undefined, makeTurn({ id: "u-1" }), 0, 5, DIR)
    expect(cut).toEqual({ cutoffLine: 0, branchPointTurnId: null })
  })

  it("falls back to the index cut, unanchored, when the whole session is loaded", () => {
    const cut = resolveUndoCut(lines, makeTurn({ id: "generated" }), makeTurn({ id: "also-generated" }), 2, 5, DIR)
    expect(cut).toEqual({ cutoffLine: 4, branchPointTurnId: undefined })
  })

  it("refuses to cut by window index when only part of the session is loaded", () => {
    // Two of five turns loaded: "keep 1 turn" would keep one turn of the file.
    expect(resolveUndoCut(lines, makeTurn({ id: "generated" }), makeTurn({ id: "also-generated" }), 1, 2, DIR)).toBeNull()
  })
})

describe("resolveUndoCut on a Codex transcript", () => {
  // Codex records carry no uuid; a turn's id is its turn_id plus the timestamp
  // that opened it, so the cut has to match parsed turn ids, not record uuids.
  const codexLines = [1, 2, 3, 4].flatMap((n) => [
    JSON.stringify({ timestamp: `2026-01-01T00:0${n}:00Z`, type: "turn_context", payload: { cwd: "/tmp", turn_id: `t-${n}` } }),
    JSON.stringify({ timestamp: `2026-01-01T00:0${n}:01Z`, type: "event_msg", payload: { type: "user_message", message: `ask ${n}` } }),
  ])
  const codexDir = "codex__L3RtcA"

  it("cuts a windowed session at the chosen turn, not at its window index", () => {
    const ids = formatFor("codex").parse(codexLines.join("\n")).turns.map((turn) => turn.id)
    // Only turns 3 and 4 are loaded; the user undoes turn 4 (window index 1).
    const cut = resolveUndoCut(codexLines, makeTurn({ id: ids[2] }), makeTurn({ id: ids[3] }), 1, 2, codexDir)
    expect(cut).toEqual({ cutoffLine: 6, branchPointTurnId: ids[2] })
  })
})

describe("buildSummary", () => {
  it("counts every turn being moved, not only the ones that touched files", () => {
    const summary = buildSummary(
      [{ type: "delete-write", filePath: "/p/a.txt", content: "a", turnIndex: 30 }],
      31,
    )
    expect(summary).toEqual({ turnCount: 31, fileCount: 1, filePaths: ["/p/a.txt"], operationCount: 1 })
  })
})
