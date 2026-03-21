import { describe, expect, it } from "vitest"
import { compareSessionsByRecency, sortSessionsByRecency } from "../sessionOrdering"

describe("sessionOrdering", () => {
  it("sorts by displayed activity time before file mtime", () => {
    const sessions = [
      {
        sessionId: "mtime-newer",
        fileName: "mtime-newer.jsonl",
        dirName: "proj",
        lastModified: "2026-03-21T12:00:00.000Z",
        lastActivityAt: "2026-03-20T12:00:00.000Z",
      },
      {
        sessionId: "activity-newer",
        fileName: "activity-newer.jsonl",
        dirName: "proj",
        lastModified: "2026-03-21T11:00:00.000Z",
        lastActivityAt: "2026-03-21T11:30:00.000Z",
      },
    ]

    expect(sortSessionsByRecency(sessions).map((session) => session.sessionId)).toEqual([
      "activity-newer",
      "mtime-newer",
    ])
  })

  it("falls back to lastModified when activity time is missing", () => {
    const sessions = [
      {
        sessionId: "older",
        fileName: "older.jsonl",
        dirName: "proj",
        lastModified: "2026-03-21T10:00:00.000Z",
      },
      {
        sessionId: "newer",
        fileName: "newer.jsonl",
        dirName: "proj",
        lastModified: "2026-03-21T11:00:00.000Z",
      },
    ]

    expect(sortSessionsByRecency(sessions).map((session) => session.sessionId)).toEqual([
      "newer",
      "older",
    ])
  })

  it("breaks ties deterministically", () => {
    const alpha = {
      sessionId: "alpha",
      fileName: "same.jsonl",
      dirName: "a",
      lastModified: "2026-03-21T10:00:00.000Z",
      lastActivityAt: "2026-03-21T10:00:00.000Z",
    }
    const beta = {
      sessionId: "beta",
      fileName: "same.jsonl",
      dirName: "b",
      lastModified: "2026-03-21T10:00:00.000Z",
      lastActivityAt: "2026-03-21T10:00:00.000Z",
    }

    expect(compareSessionsByRecency(alpha, beta)).toBeLessThan(0)
    expect(sortSessionsByRecency([beta, alpha]).map((session) => session.sessionId)).toEqual(["alpha", "beta"])
  })
})
