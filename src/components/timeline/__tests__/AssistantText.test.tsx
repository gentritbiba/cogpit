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
    render(<AssistantText text="**Useful** response" model={null} tokenUsage={null} />)

    await user.click(screen.getByRole("button", { name: "Copy response" }))

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("**Useful** response")
    expect(await screen.findByRole("button", { name: "Response copied" })).toBeInTheDocument()
  })
})
