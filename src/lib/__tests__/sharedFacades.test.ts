import { describe, expect, expectTypeOf, it } from "vitest"

import {
  computeNetDiff as rendererComputeNetDiff,
  diffLineCount as rendererDiffLineCount,
  type NetDiffResult as RendererNetDiffResult,
} from "../diffUtils"
import {
  compareSessionsByRecency as rendererCompareSessionsByRecency,
  sortSessionsByRecency as rendererSortSessionsByRecency,
  type SessionRecencyLike as RendererSessionRecencyLike,
} from "../sessionOrdering"
import type { ServerPerformanceSnapshot as RendererPerformanceSnapshot } from "../performanceTypes"
import {
  computeNetDiff as sharedComputeNetDiff,
  diffLineCount as sharedDiffLineCount,
  type NetDiffResult as SharedNetDiffResult,
} from "../../../shared/diff-utils"
import {
  compareSessionsByRecency as sharedCompareSessionsByRecency,
  sortSessionsByRecency as sharedSortSessionsByRecency,
  type SessionRecencyLike as SharedSessionRecencyLike,
} from "../../../shared/session-ordering"
import type { ServerPerformanceSnapshot as SharedPerformanceSnapshot } from "../../../shared/contracts/performance"

describe("shared utility compatibility facades", () => {
  it("re-exports the canonical diff implementations", () => {
    expect(rendererComputeNetDiff).toBe(sharedComputeNetDiff)
    expect(rendererDiffLineCount).toBe(sharedDiffLineCount)
    expectTypeOf<RendererNetDiffResult>().toEqualTypeOf<SharedNetDiffResult>()
  })

  it("re-exports the canonical session ordering implementations without mutating input", () => {
    expect(rendererCompareSessionsByRecency).toBe(sharedCompareSessionsByRecency)
    expect(rendererSortSessionsByRecency).toBe(sharedSortSessionsByRecency)
    expectTypeOf<RendererSessionRecencyLike>().toEqualTypeOf<SharedSessionRecencyLike>()

    const sessions = Object.freeze([
      Object.freeze({ sessionId: "older", lastModified: "2026-01-01T00:00:00.000Z" }),
      Object.freeze({ sessionId: "newer", lastModified: "2026-01-02T00:00:00.000Z" }),
    ])

    expect(sharedSortSessionsByRecency(sessions).map((session) => session.sessionId)).toEqual([
      "newer",
      "older",
    ])
    expect(sessions.map((session) => session.sessionId)).toEqual(["older", "newer"])
  })

  it("preserves the renderer performance wire contract exactly", () => {
    expectTypeOf<RendererPerformanceSnapshot>().toEqualTypeOf<SharedPerformanceSnapshot>()
  })
})
