import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { getTurnKey } from "../stats/turnKey"
import { emptyTurn } from "@/__tests__/fixtures"

vi.mock("@/hooks/useSessionNamer", () => ({ useSessionNamer: () => () => undefined }))

import { TurnNavigator } from "../stats/TurnNavigator"

const makeTurn = (userMessage: string) => emptyTurn({ id: "shared-live-turn-id", userMessage })

describe("TurnNavigator", () => {
  it("gives live turns unique keys even when their persisted ids collide", () => {
    const turns = [makeTurn("first"), makeTurn("second")]

    expect(getTurnKey(turns[0], 0)).not.toBe(getTurnKey(turns[1], 1))
  })

  // LOAD QA F7 (crew 2275): the highlight stayed on the clicked index after older turns were prepended.
  it("keeps the highlight on the turn it jumped to when older turns arrive in front", () => {
    const turn = (id: string) => emptyTurn({ id, userMessage: `prompt ${id}` })
    const onJumpToTurn = vi.fn()
    const view = render(<TurnNavigator turns={[turn("a"), turn("b"), turn("c")]} onJumpToTurn={onJumpToTurn} />)
    fireEvent.click(screen.getByRole("button", { name: /prompt b/ }))
    expect(onJumpToTurn).toHaveBeenCalledWith(1)

    view.rerender(<TurnNavigator turns={[turn("x"), turn("y"), turn("a"), turn("b"), turn("c")]} onJumpToTurn={onJumpToTurn} />)
    expect(screen.getByRole("button", { name: /prompt b/ })).toHaveClass("bg-accent")
    expect(screen.getByRole("button", { name: /prompt y/ })).not.toHaveClass("bg-accent")
  })
})
