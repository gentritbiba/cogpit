import { act, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const dialogState = vi.hoisted(() => ({
  open: true,
  onOpenChange: (_open: boolean) => {},
  onOpenChangeComplete: (_open: boolean) => {},
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
    onOpenChangeComplete,
  }: {
    children: ReactNode
    open: boolean
    onOpenChange: (open: boolean) => void
    onOpenChangeComplete: (open: boolean) => void
  }) => {
    dialogState.open = open
    dialogState.onOpenChange = onOpenChange
    dialogState.onOpenChangeComplete = onOpenChangeComplete
    return <div>{children}</div>
  },
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("../MiniBranchGraph", () => ({ MiniBranchGraph: () => null }))
vi.mock("../TurnCards", () => ({
  ArchivedTurnCard: () => null,
  FullTurnCard: () => null,
}))

import { BranchModal } from "../index"

describe("BranchModal", () => {
  it("stays mounted while closed and reports when its exit finishes", () => {
    const onClose = vi.fn()
    const onCloseComplete = vi.fn()

    render(
      <BranchModal
        open={false}
        branches={[]}
        branchPointTurnIndex={0}
        currentTurns={[]}
        onClose={onClose}
        onCloseComplete={onCloseComplete}
        onRedoToTurn={vi.fn()}
        onRedoEntireBranch={vi.fn()}
      />,
    )

    expect(dialogState.open).toBe(false)

    act(() => dialogState.onOpenChange(false))
    expect(onClose).toHaveBeenCalledOnce()

    act(() => dialogState.onOpenChangeComplete(false))
    expect(onCloseComplete).toHaveBeenCalledOnce()
  })
})
