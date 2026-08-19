import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigEditor } from "@/components/config/ConfigEditor"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/components/shared/HighlightedEditor", () => ({
  HighlightedEditor: ({ value, onChange, readOnly }: {
    value: string
    onChange: (value: string) => void
    readOnly: boolean
  }) => (
    <textarea
      aria-label="Config contents"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

describe("ConfigEditor read-only capability", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: "original" }),
    })
  })

  it("does not expose mutations or intercept Cmd/Ctrl+S in forced read-only mode", async () => {
    render(
      <ConfigEditor
        file={{
          name: "example.md",
          path: "/tmp/example.md",
          fileType: "command",
          description: "",
          scope: "global",
          readOnly: false,
        }}
        onDeleted={vi.fn()}
        readOnly
      />,
    )

    const editor = await screen.findByRole("textbox", { name: "Config contents" })
    expect(editor).toHaveAttribute("readonly")
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument()

    fireEvent.change(editor, { target: { value: "changed" } })
    const shortcut = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true })
    window.dispatchEvent(shortcut)
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(1))
    expect(shortcut.defaultPrevented).toBe(false)
    expect(mocks.authFetch.mock.calls.some(([, init]) =>
      ["POST", "DELETE"].includes((init as RequestInit | undefined)?.method ?? "")
    )).toBe(false)
  })
})
