import { describe, expect, it } from "vitest"
import { sameJson, shareList } from "@/lib/structuralShare"

interface Row { id: string; title: string; tags?: string[]; access?: { level: string } }

const keyOf = (row: Row) => row.id

describe("sameJson", () => {
  it("compares nested JSON values by content", () => {
    expect(sameJson({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true)
    expect(sameJson({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false)
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameJson([1], { 0: 1 })).toBe(false)
    expect(sameJson(null, {})).toBe(false)
  })
})

describe("shareList", () => {
  it("returns the previous array when a fetch brings the same rows", () => {
    const previous: Row[] = [{ id: "a", title: "A", tags: ["x"] }, { id: "b", title: "B", access: { level: "own" } }]
    const fetched: Row[] = JSON.parse(JSON.stringify(previous))
    expect(shareList(previous, fetched, keyOf)).toBe(previous)
  })

  it("keeps the previous object for every unchanged row and takes the changed one", () => {
    const previous: Row[] = [{ id: "a", title: "A" }, { id: "b", title: "B" }]
    const shared = shareList(previous, [{ id: "a", title: "A" }, { id: "b", title: "B2" }], keyOf)
    expect(shared).not.toBe(previous)
    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toEqual({ id: "b", title: "B2" })
  })

  it("keeps row objects when the order changes, but not the array", () => {
    const previous: Row[] = [{ id: "a", title: "A" }, { id: "b", title: "B" }]
    const shared = shareList(previous, [{ id: "b", title: "B" }, { id: "a", title: "A" }], keyOf)
    expect(shared).not.toBe(previous)
    expect(shared[0]).toBe(previous[1])
    expect(shared[1]).toBe(previous[0])
  })

  it("returns a new array when a row was added or removed", () => {
    const previous: Row[] = [{ id: "a", title: "A" }]
    expect(shareList(previous, [], keyOf)).toEqual([])
    const grown = shareList(previous, [{ id: "a", title: "A" }, { id: "c", title: "C" }], keyOf)
    expect(grown).not.toBe(previous)
    expect(grown[0]).toBe(previous[0])
  })
})
