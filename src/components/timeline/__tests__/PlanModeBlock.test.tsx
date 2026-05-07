import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PlanModeBlock } from "../PlanModeBlock"
import type { ToolCall } from "@/lib/types"

// Mock window.matchMedia — required by ToolCallCard → useIsMobile
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc_1",
    name: "Read",
    input: { file_path: "src/main.ts" },
    result: "file contents",
    isError: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe("PlanModeBlock", () => {
  it("renders the heading 'Plan Mode'", () => {
    render(
      <PlanModeBlock
        plan="Step 1: do something important"
        status="approved"
        toolCalls={[]}
      />
    )
    expect(screen.getByText("Plan Mode")).toBeInTheDocument()
  })

  it("renders the plan text content when open", () => {
    render(
      <PlanModeBlock
        plan="Step 1: do something important"
        status="approved"
        toolCalls={[]}
      />
    )
    expect(screen.getByText(/Step 1/)).toBeInTheDocument()
  })

  it("shows 'approved' status text and purple border styling", () => {
    const { container } = render(
      <PlanModeBlock plan="Do the thing" status="approved" toolCalls={[]} />
    )
    expect(screen.getByText("approved")).toBeInTheDocument()
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/border-purple-500/)
  })

  it("shows 'pending' status text and amber border styling", () => {
    const { container } = render(
      <PlanModeBlock plan="Do the thing" status="pending" toolCalls={[]} />
    )
    expect(screen.getByText("pending")).toBeInTheDocument()
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/border-amber-500/)
  })

  it("shows 'rejected' status text and red border styling", () => {
    const { container } = render(
      <PlanModeBlock plan="Do the thing" status="rejected" toolCalls={[]} />
    )
    expect(screen.getByText("rejected")).toBeInTheDocument()
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/border-red-500/)
  })

  it("shows planFilePath when provided", () => {
    render(
      <PlanModeBlock
        plan="Do the thing"
        planFilePath="/tmp/plan.md"
        status="approved"
        toolCalls={[]}
      />
    )
    expect(screen.getByText("/tmp/plan.md")).toBeInTheDocument()
  })

  it("does not show planFilePath when omitted", () => {
    render(<PlanModeBlock plan="Do the thing" status="pending" toolCalls={[]} />)
    expect(screen.queryByText(/\.md/)).toBeNull()
  })

  it("does not show tool calls section when toolCalls is empty", () => {
    render(<PlanModeBlock plan="Do the thing" status="approved" toolCalls={[]} />)
    expect(screen.queryByText(/call/)).toBeNull()
  })

  it("shows collapsed tool calls section when toolCalls is non-empty", () => {
    render(
      <PlanModeBlock
        plan="Do the thing"
        status="approved"
        toolCalls={[makeToolCall(), makeToolCall({ id: "tc_2" })]}
      />
    )
    expect(screen.getByText("2 calls during planning")).toBeInTheDocument()
  })

  it("shows singular 'call' for one tool call", () => {
    render(
      <PlanModeBlock plan="Do the thing" status="approved" toolCalls={[makeToolCall()]} />
    )
    expect(screen.getByText("1 call during planning")).toBeInTheDocument()
  })

  it("expands embedded tool calls on click and renders tool name", () => {
    render(
      <PlanModeBlock
        plan="Do the thing"
        status="approved"
        toolCalls={[makeToolCall({ name: "Read", input: { file_path: "src/main.ts" } })]}
      />
    )

    const callsButton = screen.getByText("1 call during planning")

    // ToolCallCard not visible before expansion (file_path badge not shown)
    expect(screen.queryByText("src/main.ts")).toBeNull()

    fireEvent.click(callsButton)

    // After expanding, the tool call card appears with the file path
    expect(screen.getByText("src/main.ts")).toBeInTheDocument()
  })

  it("collapses the entire block when header button is clicked", () => {
    render(
      <PlanModeBlock plan="unique-plan-text-xyz" status="approved" toolCalls={[]} />
    )

    // Initially open — plan content visible
    expect(screen.getByText(/unique-plan-text-xyz/)).toBeInTheDocument()

    // The first button is the header toggle
    const buttons = screen.getAllByRole("button")
    fireEvent.click(buttons[0])

    // Content should be hidden after collapse
    expect(screen.queryByText(/unique-plan-text-xyz/)).toBeNull()
  })
})
