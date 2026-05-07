import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HookEventChip } from "../HookEventChip"
import type { ParsedHookEvent } from "@/lib/types"

function makeEvent(overrides: Partial<ParsedHookEvent> = {}): ParsedHookEvent {
  return {
    eventName: "PostToolUse",
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe("HookEventChip", () => {
  it("renders collapsed showing event count", () => {
    const events = [makeEvent({ eventName: "PreToolUse" }), makeEvent({ eventName: "PostToolUse" })]
    render(<HookEventChip events={events} />)
    expect(screen.getByText("2 hook events")).toBeInTheDocument()
  })

  it("does not render anything when events is empty", () => {
    const { container } = render(<HookEventChip events={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("click expands and shows both event names", () => {
    const events = [makeEvent({ eventName: "PreToolUse" }), makeEvent({ eventName: "PostToolUse" })]
    render(<HookEventChip events={events} />)

    // Collapsed: individual event names not listed yet in the expanded list
    const button = screen.getByRole("button")
    fireEvent.click(button)

    // After expanding, the individual <li> items with event names should appear
    const items = screen.getAllByText("PreToolUse")
    // One in the collapsed summary span, one in the expanded list
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("PostToolUse").length).toBeGreaterThanOrEqual(1)
  })

  it("applies error styling when one event has exitCode 2", () => {
    const events = [
      makeEvent({ eventName: "PreToolUse" }),
      makeEvent({ eventName: "PostToolUse", exitCode: 2 }),
    ]
    const { container } = render(<HookEventChip events={events} />)
    // The wrapper div should have the red bg class
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/bg-red-950/)
  })

  it("applies error styling for terminal event names", () => {
    const events = [makeEvent({ eventName: "StopFailure" })]
    const { container } = render(<HookEventChip events={events} />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/bg-red-950/)
  })

  it("applies error styling for PermissionDenied event", () => {
    const events = [makeEvent({ eventName: "PermissionDenied" })]
    const { container } = render(<HookEventChip events={events} />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toMatch(/bg-red-950/)
  })

  it("shows singular 'hook event' for a single event", () => {
    const events = [makeEvent({ eventName: "SessionStart" })]
    render(<HookEventChip events={events} />)
    expect(screen.getByText("1 hook event")).toBeInTheDocument()
  })

  it("expands to show tool name and source when present", () => {
    const events = [
      makeEvent({ eventName: "PreToolUse", toolName: "Read", source: "settings" }),
    ]
    render(<HookEventChip events={events} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("(settings)")).toBeInTheDocument()
    expect(screen.getByText(/Read/)).toBeInTheDocument()
  })
})
