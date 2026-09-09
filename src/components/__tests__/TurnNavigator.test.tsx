import { describe, expect, it } from "vitest"
import { getTurnKey } from "../stats/turnKey"
import { emptyTurn } from "@/__tests__/fixtures"

const makeTurn = (userMessage: string) => emptyTurn({ id: "shared-live-turn-id", userMessage })

describe("TurnNavigator", () => {
  it("gives live turns unique keys even when their persisted ids collide", () => {
    const turns = [makeTurn("first"), makeTurn("second")]

    expect(getTurnKey(turns[0], 0)).not.toBe(getTurnKey(turns[1], 1))
  })
})
