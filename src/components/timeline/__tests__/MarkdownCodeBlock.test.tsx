import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MarkdownCodeBlock } from "../MarkdownCodeBlock"

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  highlightCode: vi.fn(),
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/utils")>(),
  copyToClipboard: mocks.copyToClipboard,
}))
vi.mock("@/lib/shiki", () => ({ highlightCode: mocks.highlightCode }))
vi.mock("@/hooks/useIsDarkMode", () => ({ useIsDarkMode: () => false }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyToClipboard.mockResolvedValue(true)
  mocks.highlightCode.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("MarkdownCodeBlock lifecycle", () => {
  it("shows plain current code while replacement highlighting is pending", async () => {
    const first = deferred<Array<Array<{ content: string; color?: string }>>>()
    const second = deferred<Array<Array<{ content: string; color?: string }>>>()
    mocks.highlightCode
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const view = render(
      <MarkdownCodeBlock className="language-ts">first</MarkdownCodeBlock>,
    )

    await act(async () => {
      first.resolve([[{ content: "FIRST-HIGHLIGHT", color: "red" }]])
      await first.promise
    })
    expect(screen.getByText("FIRST-HIGHLIGHT")).toBeInTheDocument()

    view.rerender(
      <MarkdownCodeBlock className="language-js">second</MarkdownCodeBlock>,
    )

    expect(screen.queryByText("FIRST-HIGHLIGHT")).not.toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()

    await act(async () => {
      second.resolve([[{ content: "SECOND-HIGHLIGHT", color: "blue" }]])
      await second.promise
    })
    expect(screen.getByText("SECOND-HIGHLIGHT")).toBeInTheDocument()
  })

  it("keeps copy feedback for two seconds after the latest successful copy", async () => {
    vi.useFakeTimers()
    render(<MarkdownCodeBlock className="language-ts">const value = 1</MarkdownCodeBlock>)

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole("button", { name: "Copied" })).toHaveAttribute("type", "button")

    act(() => vi.advanceTimersByTime(1_000))
    fireEvent.click(screen.getByRole("button", { name: "Copied" }))
    await act(async () => { await Promise.resolve() })

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument()
  })

  it("does not start copy feedback after the block unmounts", async () => {
    vi.useFakeTimers()
    const copy = deferred<boolean>()
    mocks.copyToClipboard.mockReturnValueOnce(copy.promise)
    const view = render(
      <MarkdownCodeBlock className="language-ts">const value = 1</MarkdownCodeBlock>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
    view.unmount()

    await act(async () => {
      copy.resolve(true)
      await copy.promise
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it("marks collapse controls as non-submit buttons", async () => {
    const code = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`).join("\n")
    mocks.highlightCode.mockResolvedValueOnce(
      Array.from({ length: 31 }, (_, index) => [{ content: `highlighted ${index + 1}` }]),
    )
    render(<MarkdownCodeBlock className="language-ts">{code}</MarkdownCodeBlock>)

    expect(await screen.findByText("highlighted 1")).toBeInTheDocument()

    const collapse = screen.getByRole("button", { name: "Collapse code" })
    expect(collapse).toHaveAttribute("type", "button")

    fireEvent.click(collapse)
    expect(screen.getByRole("button", { name: "Expand 31 lines of code" })).toHaveAttribute("type", "button")
  })
})
