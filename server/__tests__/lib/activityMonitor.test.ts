import { beforeEach, describe, expect, it } from "vitest"

import {
  _resetActivityMonitorForTests,
  beginActivity,
  createServerPerformanceSnapshot,
  normalizeApiPath,
  recordActivity,
  recordRequest,
} from "../../lib/activityMonitor"

describe("activityMonitor", () => {
  beforeEach(() => {
    _resetActivityMonitorForTests()
  })

  it("reports recent activity, throughput, active streams, and requests", () => {
    const endStream = beginActivity("Open live session streams")
    recordActivity("Session file checks", { count: 2 })
    recordActivity("Session JSONL reads", { bytes: 4096 })
    recordRequest("GET /api/projects", 24)

    const snapshot = createServerPerformanceSnapshot()

    expect(snapshot.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(snapshot.eventLoopPercent).toBeGreaterThanOrEqual(0)
    expect(snapshot.memory.rssMb).toBeGreaterThan(0)
    expect(snapshot.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Open live session streams", active: 1 }),
      expect.objectContaining({ name: "Session file checks", count: 2, totalCount: 2 }),
      expect.objectContaining({ name: "Session JSONL reads", totalCount: 1 }),
    ]))
    expect(snapshot.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "GET /api/projects",
        totalCount: 1,
        averageDurationMs: 24,
      }),
    ]))

    endStream()
    endStream()
    expect(createServerPerformanceSnapshot().activities)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Open live session streams", active: 1 }),
      ]))
  })

  it("normalizes dynamic API paths into stable activity labels", () => {
    expect(normalizeApiPath("/watch/project/session.jsonl?offset=12"))
      .toBe("GET /api/watch/:session")
    expect(normalizeApiPath("/sessions/project-name?page=2"))
      .toBe("GET /api/sessions/:project")
    expect(normalizeApiPath("/permissions/session-id", "post"))
      .toBe("POST /api/permissions")
  })
})
