// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { VisibilityCheck, VisibleSession } from "../../edition"
import { visibleLineage } from "../../routes/projects/visibleLineage"

const SEEN: VisibleSession = { annotate: async (item) => item }

/** A check that hides exactly `hiddenIds`. */
function checkHiding(hiddenIds: readonly string[], everything = false) {
  const check = vi.fn(async (sessionId: string): Promise<VisibleSession | "hidden"> =>
    hiddenIds.includes(sessionId) ? "hidden" : SEEN)
  return Object.assign(check, { everything, nothing: false }) satisfies VisibilityCheck
}

describe("visibleLineage", () => {
  it("drops the references to sessions the caller cannot see", async () => {
    const lineage = visibleLineage(checkHiding(["theirs"]))

    await expect(lineage({
      sessionId: "mine",
      branchedFrom: { sessionId: "theirs", turnIndex: 2 },
      parentSessionId: "theirs",
      teamLeadSessionId: "lead",
    })).resolves.toStrictEqual({
      sessionId: "mine",
      branchedFrom: undefined,
      parentSessionId: null,
      teamLeadSessionId: "lead",
    })
  })

  it("keeps a row whose references the caller can see", async () => {
    const row = { sessionId: "mine", branchedFrom: { sessionId: "shared" }, parentSessionId: null }
    await expect(visibleLineage(checkHiding([]))(row)).resolves.toEqual(row)
  })

  it("checks each referenced session once", async () => {
    const check = checkHiding(["lead"])
    const lineage = visibleLineage(check)

    await Promise.all(["a", "b"].map((sessionId) => lineage({ sessionId, teamLeadSessionId: "lead" })))

    expect(check).toHaveBeenCalledOnce()
  })

  it("checks nothing for a caller who sees every session", async () => {
    const check = checkHiding(["theirs"], true)
    const row = { sessionId: "mine", parentSessionId: "theirs" }

    await expect(visibleLineage(check)(row)).resolves.toBe(row)
    expect(check).not.toHaveBeenCalled()
  })
})
