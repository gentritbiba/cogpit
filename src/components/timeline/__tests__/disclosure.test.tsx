import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import {
  DisclosureProvider,
  DisclosureScope,
  timelineStoreFor,
  useDisclosure,
  useDisclosureKey,
  useScopeTurnKey,
  useTimelineDraft,
  useTimelineStore,
  type TimelineStateStore,
} from "../disclosure"

function Toggle({ name, initial = false }: { name: string; initial?: boolean | (() => boolean) }) {
  const [open, setOpen] = useDisclosure(useDisclosureKey(name), initial)
  return <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{name}</button>
}

function Draft({ name }: { name: string }) {
  const [text, setText] = useTimelineDraft(useDisclosureKey(name), "")
  return <textarea aria-label={name} value={text} onChange={(event) => setText(event.target.value)} />
}

function KeyProbe({ name }: { name: string }) {
  return <span data-testid={name}>{`${useDisclosureKey(name)}|${useScopeTurnKey()}`}</span>
}

let captured: TimelineStateStore | null = null
function CaptureStore() {
  captured = useTimelineStore()
  return null
}

describe("timeline disclosure store", () => {
  it("keeps a disclosure open across the row unmounting and mounting again", () => {
    const { rerender } = render(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Toggle name="panel" /></DisclosureScope>
      </DisclosureProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "panel" }))
    expect(screen.getByRole("button", { name: "panel" })).toHaveAttribute("aria-expanded", "true")

    rerender(<DisclosureProvider>{null}</DisclosureProvider>)
    expect(screen.queryByRole("button", { name: "panel" })).toBeNull()

    rerender(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Toggle name="panel" /></DisclosureScope>
      </DisclosureProvider>,
    )
    expect(screen.getByRole("button", { name: "panel" })).toHaveAttribute("aria-expanded", "true")
  })

  it("stores the first resolved default, so a remount keeps what the first mount decided", () => {
    const first = vi.fn(() => true)
    const { rerender } = render(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Toggle name="work" initial={first} /></DisclosureScope>
      </DisclosureProvider>,
    )
    rerender(<DisclosureProvider>{null}</DisclosureProvider>)
    const later = vi.fn(() => false)
    rerender(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Toggle name="work" initial={later} /></DisclosureScope>
      </DisclosureProvider>,
    )

    expect(screen.getByRole("button", { name: "work" })).toHaveAttribute("aria-expanded", "true")
    expect(first).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  })

  it("keeps a half-typed draft when its row unmounts", () => {
    const { rerender } = render(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Draft name="answer" /></DisclosureScope>
      </DisclosureProvider>,
    )
    fireEvent.change(screen.getByRole("textbox", { name: "answer" }), { target: { value: "Use the second" } })

    rerender(<DisclosureProvider>{null}</DisclosureProvider>)
    rerender(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root><Draft name="answer" /></DisclosureScope>
      </DisclosureProvider>,
    )

    expect(screen.getByRole("textbox", { name: "answer" })).toHaveValue("Use the second")
  })

  it("opens a disclosure by key for navigation", () => {
    render(
      <DisclosureProvider>
        <CaptureStore />
        <DisclosureScope id="turn-1" root><Toggle name="panel" /></DisclosureScope>
      </DisclosureProvider>,
    )

    act(() => captured!.open("turn-1:panel"))

    expect(screen.getByRole("button", { name: "panel" })).toHaveAttribute("aria-expanded", "true")
  })

  it("keys nested scopes under their turn, and ids unique in the turn directly under it", () => {
    render(
      <DisclosureProvider>
        <DisclosureScope id="turn-1" root>
          <DisclosureScope id="block-a">
            <KeyProbe name="nested" />
            <DisclosureScope id="call:x" underTurn><KeyProbe name="call" /></DisclosureScope>
          </DisclosureScope>
        </DisclosureScope>
      </DisclosureProvider>,
    )

    expect(screen.getByTestId("nested")).toHaveTextContent("turn-1:block-a:nested|turn-1")
    expect(screen.getByTestId("call")).toHaveTextContent("turn-1:call:x:call|turn-1")
  })

  it("keeps state local outside a provider or a scope", () => {
    render(
      <>
        <Toggle name="loose" />
        <DisclosureProvider><Toggle name="unscoped" /></DisclosureProvider>
      </>,
    )
    fireEvent.click(screen.getByRole("button", { name: "loose" }))
    fireEvent.click(screen.getByRole("button", { name: "unscoped" }))

    expect(screen.getByRole("button", { name: "loose" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "unscoped" })).toHaveAttribute("aria-expanded", "true")
  })

  it("gives each session its own store and keeps it across a switch back", () => {
    const a = timelineStoreFor("disclosure-test-a")
    const b = timelineStoreFor("disclosure-test-b")

    expect(a).not.toBe(b)
    expect(timelineStoreFor("disclosure-test-a")).toBe(a)
  })
})
