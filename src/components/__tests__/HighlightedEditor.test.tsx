import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HighlightedEditor } from "@/components/shared/HighlightedEditor"

const mocks = vi.hoisted(() => ({ highlightCode: vi.fn() }))
vi.mock("@/lib/shiki", () => ({
  highlightCode: mocks.highlightCode,
  getLangFromPath: (path: string) => (path.endsWith(".ts") ? "typescript" : null),
}))

function renderEditor(value: string) {
  return render(
    <HighlightedEditor
      value={value}
      onChange={vi.fn()}
      readOnly={false}
      filePath="src/app.ts"
      ariaLabel="Editing src/app.ts"
    />,
  )
}

describe("HighlightedEditor", () => {
  beforeEach(() => {
    mocks.highlightCode.mockReset()
    mocks.highlightCode.mockResolvedValue([[{ content: "const", color: "#79c0ff", offset: 0 }]])
  })

  it("tokenizes the file with the language inferred from its path", async () => {
    renderEditor("const value = 1\n")

    await waitFor(() => expect(mocks.highlightCode).toHaveBeenCalledWith(
      "const value = 1\n",
      "typescript",
      expect.any(Boolean),
    ))
  })

  it("keeps the file editable without tokenizing when it is too large", async () => {
    const huge = "x".repeat(200_001)
    const { rerender } = renderEditor(huge)

    expect(screen.getByRole("textbox", { name: "Editing src/app.ts" })).toHaveValue(huge)

    // Re-render small so there is a positive signal to wait on: if the huge
    // value had been tokenized, this would be the second call, not the first.
    const small = "const value = 1\n"
    rerender(
      <HighlightedEditor
        value={small}
        onChange={vi.fn()}
        readOnly={false}
        filePath="src/app.ts"
        ariaLabel="Editing src/app.ts"
      />,
    )

    await waitFor(() => expect(mocks.highlightCode).toHaveBeenCalledTimes(1))
    expect(mocks.highlightCode).toHaveBeenCalledWith(small, "typescript", expect.any(Boolean))
  })
})
