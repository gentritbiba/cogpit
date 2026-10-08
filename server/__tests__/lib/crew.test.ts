// @vitest-environment node
import { describe, expect, it } from "vitest"
import { crewRootOf, foldCrews } from "../../lib/crew"
import type { CrewLink } from "../../lib/sessionOrigins"

interface Candidate { id: string; mtimeMs: number }

const links = (entries: Array<[string, string, number?]>): ReadonlyMap<string, CrewLink> =>
  new Map(entries.map(([child, parent, createdAt = 0]) => [child, { parentSessionId: parent, createdAt }]))

const fold = (
  candidates: Candidate[],
  parents: ReadonlyMap<string, CrewLink>,
  canHost: (id: string) => boolean = () => true,
) => foldCrews(candidates, parents, { idOf: (c) => c.id, mtimeOf: (c) => c.mtimeMs, canHost })

const ids = (items: readonly Candidate[]) => items.map((item) => item.id)

describe("crewRootOf", () => {
  it("walks to the first session nothing started", () => {
    const parents = links([["reviewer", "lane"], ["lane", "coordinator"]])
    expect(crewRootOf("reviewer", parents)).toBe("coordinator")
    expect(crewRootOf("lane", parents)).toBe("coordinator")
    expect(crewRootOf("coordinator", parents)).toBe("coordinator")
    expect(crewRootOf("stranger", parents)).toBe("stranger")
  })

  it("stops on a cycle instead of looping", () => {
    const parents = links([["a", "b"], ["b", "a"]])
    expect(["a", "b"]).toContain(crewRootOf("a", parents))
  })
})

describe("foldCrews", () => {
  it("leaves sessions nobody started as they are, newest first", () => {
    const result = fold([{ id: "old", mtimeMs: 1 }, { id: "new", mtimeMs: 2 }], links([]))
    expect(ids(result.units)).toEqual(["new", "old"])
    expect(result.membersOf.size).toBe(0)
  })

  it("folds every level of a crew under its root and lists the root by the crew's latest activity", () => {
    const result = fold([
      { id: "reviewer", mtimeMs: 50 },
      { id: "other", mtimeMs: 40 },
      { id: "lane-b", mtimeMs: 30 },
      { id: "lane-a", mtimeMs: 20 },
      { id: "coordinator", mtimeMs: 10 },
    ], links([["lane-a", "coordinator", 1], ["lane-b", "coordinator", 2], ["reviewer", "lane-a", 3]]))

    expect(ids(result.units)).toEqual(["coordinator", "other"])
    expect(ids(result.membersOf.get("coordinator")!)).toEqual(["lane-a", "lane-b", "reviewer"])
    expect(result.crewMtime.get("coordinator")).toBe(50)
  })

  it("moves a crew up the list only for members that will be listed with it", () => {
    const result = foldCrews([
      { id: "hidden", mtimeMs: 90 },
      { id: "other", mtimeMs: 50 },
      { id: "coordinator", mtimeMs: 10 },
    ], links([["hidden", "coordinator"]]), {
      idOf: (c) => c.id, mtimeOf: (c) => c.mtimeMs, canHost: () => true, counts: (id) => id !== "hidden",
    })
    expect(ids(result.units)).toEqual(["other", "coordinator"])
    expect(ids(result.membersOf.get("coordinator")!)).toEqual(["hidden"])
  })

  it("keeps a member on its own when its root is not listed", () => {
    const result = fold([{ id: "lane", mtimeMs: 2 }], links([["lane", "coordinator"]]))
    expect(ids(result.units)).toEqual(["lane"])
    expect(result.membersOf.size).toBe(0)
  })

  it("folds under the highest ancestor that can be listed when the root cannot", () => {
    const result = fold([
      { id: "coordinator", mtimeMs: 1 },
      { id: "lane", mtimeMs: 2 },
      { id: "reviewer", mtimeMs: 3 },
    ], links([["lane", "coordinator"], ["reviewer", "lane"]]), (id) => id !== "coordinator")

    expect(ids(result.units)).toEqual(["lane", "coordinator"])
    expect(ids(result.membersOf.get("lane")!)).toEqual(["reviewer"])
  })

  it("does not hang on a cycle in the recorded links", () => {
    const result = fold([{ id: "a", mtimeMs: 1 }, { id: "b", mtimeMs: 2 }], links([["a", "b"], ["b", "a"]]))
    expect(result.units.length + [...result.membersOf.values()].flat().length).toBe(2)
  })
})
