import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ToolCallInput } from "../ToolCallInput"

describe("ToolCallInput", () => {
  it.each(["todos", "plan"])("renders %s as readable tasks with completion states", (key) => {
    const labelKey = key === "todos" ? "content" : "step"
    render(<ToolCallInput input={{ [key]: [
      { [labelKey]: "Inspect calls", status: "completed" },
      { [labelKey]: "Standardize views", status: "in_progress" },
      { [labelKey]: "Check mobile", status: "pending" },
    ] }} />)
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
    expect(screen.getByText("Inspect calls")).toBeTruthy()
    expect(screen.getByRole("img", { name: "Completed" })).toBeTruthy()
    expect(screen.getByRole("img", { name: "In progress" })).toBeTruthy()
    expect(screen.getByRole("img", { name: "Pending" })).toBeTruthy()
  })

  it("shows recipient and message fields without JSON syntax", () => {
    render(<ToolCallInput input={{ target: "renderer", message: "Please check the compact layout." }} />)
    expect(screen.getByText("Recipient")).toBeTruthy()
    expect(screen.getByText("renderer")).toBeTruthy()
    expect(screen.getByText("Message")).toBeTruthy()
    expect(screen.getByText("Please check the compact layout.")).toBeTruthy()
  })

  it("keeps encrypted payloads out of the readable message", () => {
    const message = `gAAAAA${"abcdef0123456789".repeat(30)}`
    render(<ToolCallInput input={{ target: "renderer", message }} />)
    expect(screen.getByText("renderer")).toBeTruthy()
    expect(screen.getByText("Encrypted message")).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
  })

  it("bounds long task messages and exposes the full text on request", () => {
    const message = "a".repeat(1000)
    render(<ToolCallInput input={{ message }} />)
    expect(screen.queryByText(message)).toBeNull()
    const showMore = screen.getByRole("button", { name: "Show more" })
    expect(showMore).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(showMore)
    expect(screen.getByText(message)).toHaveClass("max-h-96", "overflow-auto")
    expect(showMore).toHaveAttribute("aria-expanded", "true")
  })

  it("keeps unsupported nested structures for the raw input disclosure", () => {
    const { container } = render(<ToolCallInput input={{ raw: "source", complex: { nested: true } }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders Codex question titles and both option formats as readable history", () => {
    render(<ToolCallInput input={{ questions: [{
      title: "Which layout?",
      options: ["Compact", { label: "Comfortable", description: "More room between rows" }],
    }, { question: "Any other changes?" }] }} />)
    expect(screen.getByRole("region", { name: "Questions" })).toBeTruthy()
    expect(screen.getByText("Which layout?")).toBeTruthy()
    expect(screen.getByText("Compact")).toBeTruthy()
    expect(screen.getByText("Comfortable")).toBeTruthy()
    expect(screen.getByText("More room between rows")).toBeTruthy()
    expect(screen.getByText("Any other changes?")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })

})
