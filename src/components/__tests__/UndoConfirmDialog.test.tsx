import type { ComponentProps, ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-testid="alert-dialog" data-open={open}>{children}</div>
  ),
  AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
  AlertDialogCancel: (props: ComponentProps<"button">) => <button {...props} />,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogMedia: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { UndoConfirmDialog } from "../UndoConfirmDialog"
import type { UndoConfirmState } from "@/hooks/useUndoRedo"

const confirmState: UndoConfirmState = {
  type: "undo",
  targetTurnIndex: 2,
  summary: {
    turnCount: 3,
    fileCount: 1,
    operationCount: 2,
    filePaths: ["src/App.tsx"],
  },
}

describe("UndoConfirmDialog", () => {
  it("retains its payload while the dialog animates closed", () => {
    const props = {
      isApplying: false,
      applyError: null,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    }
    const { rerender } = render(<UndoConfirmDialog {...props} state={confirmState} />)

    expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "true")
    expect(screen.getByRole("heading", { name: "Undo turns?" })).toBeInTheDocument()

    rerender(<UndoConfirmDialog {...props} state={null} />)

    expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "false")
    expect(screen.getByRole("heading", { name: "Undo turns?" })).toBeInTheDocument()
  })

  it("lets Copilot users explicitly opt into restoring files", () => {
    const onConfirm = vi.fn()
    render(
      <UndoConfirmDialog
        state={{
          ...confirmState,
          copilot: {
            eventId: "event-2",
            mode: "conversation",
            filesAvailable: true,
          },
        }}
        isApplying={false}
        applyError={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText(/Files stay unchanged/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Restore captured file changes" }))
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})
