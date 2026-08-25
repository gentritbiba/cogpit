import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AssistantText } from "@/components/timeline/AssistantText"

const mocks = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/utils")>(),
  copyToClipboard: mocks.copyToClipboard,
}))

describe("AssistantText", () => {
  beforeEach(() => mocks.copyToClipboard.mockResolvedValue(true))

  it("copies the raw assistant response and shows feedback", async () => {
    const user = userEvent.setup()
    render(<AssistantText text="**Useful** response" model={null} />)

    await user.click(screen.getByRole("button", { name: "Copy response" }))

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("**Useful** response")
    expect(await screen.findByRole("button", { name: "Response copied" })).toBeInTheDocument()
  })

  it("shows the reasoning effort next to the model", () => {
    render(<AssistantText text="hi" model="claude-opus-5" effort="xhigh" />)

    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText("xhigh")).toBeInTheDocument()
  })

  it("omits the effort label when the turn recorded none", () => {
    render(<AssistantText text="hi" model="claude-opus-5" />)

    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.queryByText("xhigh")).not.toBeInTheDocument()
  })

  it("shows effort even when the model is unknown", () => {
    render(<AssistantText text="hi" model={null} effort="max" />)

    expect(screen.getByText("max")).toBeInTheDocument()
  })

  it("hides the whole header row in compact mode", () => {
    render(<AssistantText text="hi" model="claude-opus-5" effort="xhigh" compact />)

    expect(screen.queryByText("xhigh")).not.toBeInTheDocument()
  })
})
