import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionCardList } from "../SessionCardList"
import type { ActiveSessionInfo } from "../types"

const rowState = vi.hoisted(() => ({ described: [] as string[] }))

vi.mock("../sessionRowState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessionRowState")>()
  return {
    ...actual,
    describeSessionRow: (...args: Parameters<typeof actual.describeSessionRow>) => {
      rowState.described.push(args[0].sessionId)
      return actual.describeSessionRow(...args)
    },
  }
})

function session(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "-work-app",
    projectShortName: "app",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    cwd: "/work/app",
    lastModified: "2026-09-10T10:00:00Z",
    size: 100,
    ...overrides,
  }
}

const shared = {
  older: { canLoad: false, loading: false, load: () => {} },
  procBySession: new Map(),
  killingPids: new Set<number>(),
  newlyCompleted: new Set<string>(),
  sessionNames: {},
  projectNames: {},
  onSelectSession: () => {},
  onArchiveSession: () => {},
}

afterEach(cleanup)

describe("SessionCardList rendering", () => {
  it("re-renders only the card whose row changed", () => {
    const a = session("a", { lastModified: "2026-09-10T10:05:00Z" })
    const b = session("b")
    const { rerender } = render(<SessionCardList {...shared} activeSessionKey={null} sessions={[a, b]} />)
    rowState.described.length = 0

    rerender(<SessionCardList {...shared} activeSessionKey={null} sessions={[a, { ...b, agentStatus: "thinking" }]} />)

    expect(rowState.described).toEqual(["b"])
  })

  it("re-renders only the cards whose selection changed when another session opens", () => {
    const sessions = [session("a", { lastModified: "2026-09-10T10:05:00Z" }), session("b"), session("c")]
    const { rerender } = render(<SessionCardList {...shared} activeSessionKey="-work-app/a.jsonl" sessions={sessions} />)
    rowState.described.length = 0

    rerender(<SessionCardList {...shared} activeSessionKey="-work-app/b.jsonl" sessions={sessions} />)

    expect(rowState.described.sort()).toEqual(["a", "b"])
  })
})
