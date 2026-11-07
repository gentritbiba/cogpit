import { describe, it, expect } from "vitest"
import { turnKeysOf } from "../turnKeys"
import type { Turn } from "../../../../shared/session/types"

const turns = (...ids: string[]) => ids.map((id) => ({ id }) as Turn)

describe("turnKeysOf", () => {
  it("keys by turn id and disambiguates repeats", () => {
    expect(turnKeysOf(turns("a", "b", "a"))).toEqual(["a", "b", "a#1"])
  })

  it("keeps keys stable when older turns are prepended", () => {
    const before = turnKeysOf(turns("c", "d"))
    const after = turnKeysOf(turns("a", "b", "c", "d"))
    expect(after.slice(2)).toEqual(before)
  })
})
