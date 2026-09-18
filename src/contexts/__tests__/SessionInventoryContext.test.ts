import { describe, expect, it } from "vitest"
import { learnArchivedIds } from "../SessionInventoryContext"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

function row(sessionId: string, archived?: boolean): ActiveSessionInfo {
  return {
    dirName: "d",
    projectShortName: "P",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    lastModified: "2026-09-18T10:00:00.000Z",
    size: 1,
    ...(archived ? { archived: true, archivedReason: "manual" as const } : {}),
  }
}

describe("learnArchivedIds", () => {
  it("keeps an archived id the default list no longer mentions", () => {
    const known = new Set(["hidden"])
    expect(learnArchivedIds(known, [row("keep")])).toBe(known)
  })

  it("settles listed rows either way", () => {
    const next = learnArchivedIds(new Set(["restored"]), [row("restored"), row("old", true)])
    expect([...next]).toEqual(["old"])
  })

  it("returns the same set when nothing changed", () => {
    const known = new Set(["old"])
    expect(learnArchivedIds(known, [row("old", true), row("keep")])).toBe(known)
  })
})
