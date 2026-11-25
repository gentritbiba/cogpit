import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceStage } from "../DeviceStage"
import { useDeviceId } from "@/contexts/DevicePaneContext"
import { switchDevice } from "@/lib/device"

const machines = [{ id: "local", name: "This machine" }, { id: "dev_1", name: "Studio" }]

function PaneContent() {
  return <p>{`content of ${useDeviceId()}`}</p>
}

function renderStage(panes = [{ key: "local", deviceId: "local" }], active = "local") {
  return render(
    <DeviceStage panes={panes} activeDeviceId={active} machines={machines} swipeEnabled renderPane={() => <PaneContent />} />,
  )
}

interface Played {
  keyframes: Keyframe[]
  duration: number
  cancelled: boolean
  finished: boolean
}

/** jsdom has no Web Animations: play each one on a timer, finishing on time unless cancelled. */
function playAnimations(): Played[] {
  const played: Played[] = []
  Element.prototype.animate = function animate(keyframes, options) {
    const duration = typeof options === "number" ? options : Number(options?.duration ?? 0)
    const record: Played = { keyframes: keyframes as Keyframe[], duration, cancelled: false, finished: false }
    played.push(record)
    const startedAt = performance.now()
    const animation = {
      onfinish: null as (() => void) | null,
      get currentTime() { return performance.now() - startedAt },
      cancel() {
        record.cancelled = true
        clearTimeout(timer)
      },
    }
    const timer = setTimeout(() => {
      record.finished = true
      animation.onfinish?.()
    }, duration)
    return animation as unknown as Animation
  }
  return played
}

const track = () => document.querySelector<HTMLElement>("[data-device-pane]")!.parentElement!
const pane = (id: string) => document.querySelector<HTMLElement>(`[data-device-pane="${id}"]`)!
const frameShown = (id: string) => (pane(id).firstElementChild as HTMLElement).style.display !== "none"

/** A trackpad swipe on the machine on screen: `deltas` one frame apart, then the fingers go still. */
async function swipe(deltas: number[]) {
  const target = screen.getByText("content of local")
  for (const deltaX of deltas) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 8))
  }
}

const bothPanes = [{ key: "local", deviceId: "local" }, { key: "dev_1", deviceId: "dev_1" }]

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }))
}

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  // @ts-expect-error jsdom has none; the tests that need it install one.
  delete Element.prototype.animate
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

describe("DeviceStage", () => {
  it("gives each pane its own machine", () => {
    renderStage([{ key: "local", deviceId: "local" }, { key: "dev_1", deviceId: "dev_1" }], "dev_1")
    expect(screen.getByText("content of local")).toBeInTheDocument()
    expect(screen.getByText("content of dev_1")).toBeInTheDocument()
  })

  it("slides an explicit switch to a machine not opened yet past its poster, committing before the slide ends", async () => {
    reduceMotion(false)
    const played = playAnimations()
    renderStage()
    act(() => switchDevice("dev_1"))
    expect(window.location.pathname).toBe("/")
    expect(screen.getByText("Studio", { selector: "span.text-sm" })).toBeInTheDocument()
    const [slide] = played
    expect(slide.duration).toBeGreaterThan(100)
    await waitFor(() => expect(window.location.pathname).toBe("/d/dev_1/"))
    // The new machine is in charge while the slide is still playing.
    expect(slide.finished).toBe(false)
    expect(screen.getByRole("status")).toHaveTextContent("Now on Studio")
  })

  it("drops a slide that Back overtook instead of adding the machine to history again", async () => {
    reduceMotion(false)
    playAnimations()
    const { rerender } = renderStage()
    act(() => switchDevice("dev_1"))
    const push = vi.spyOn(window.history, "pushState")

    // Back lands on the slide's destination before the slide does.
    rerender(
      <DeviceStage
        panes={[{ key: "local", deviceId: "local" }, { key: "dev_1", deviceId: "dev_1" }]}
        activeDeviceId="dev_1"
        machines={machines}
        swipeEnabled
        renderPane={() => <PaneContent />}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(push).not.toHaveBeenCalled()
    for (const pane of document.querySelectorAll<HTMLElement>("[data-device-pane]")) expect(pane.style.transform).toBe("")
    expect(track().style.transform).toBe("")
  })

  it("drags the machines with the fingers, then lands on the next one", async () => {
    reduceMotion(false)
    const played = playAnimations()
    renderStage(bothPanes)
    expect(frameShown("dev_1")).toBe(false)
    await swipe(Array.from({ length: 12 }, () => 40))
    // The track follows the fingers; the next machine waits a width to the right, its last frame uncovered.
    expect(track().style.transform).toBe("translate3d(-480px, 0, 0)")
    expect(pane("dev_1").style.transform).toBe(`translate3d(${window.innerWidth}px, 0, 0)`)
    expect(frameShown("dev_1")).toBe(true)
    await waitFor(() => expect(window.location.pathname).toBe("/d/dev_1/"))
    expect(played[0].finished).toBe(false)
  })

  it("springs a short pull back without switching, and covers the next machine again", async () => {
    reduceMotion(false)
    const played = playAnimations()
    renderStage(bothPanes)
    const push = vi.spyOn(window.history, "pushState")
    await swipe([12, 12, 12])
    expect(frameShown("dev_1")).toBe(true)
    await waitFor(() => expect(played[0]?.finished).toBe(true))
    expect(push).not.toHaveBeenCalled()
    expect(track().style.transform).toBe("")
    expect(pane("dev_1").style.transform).toBe("")
    expect(frameShown("dev_1")).toBe(false)
  })

  it("catches a sliding view where it is, before the switch counts", async () => {
    reduceMotion(false)
    const played = playAnimations()
    renderStage(bothPanes)
    const push = vi.spyOn(window.history, "pushState")
    act(() => switchDevice("dev_1"))
    await new Promise((resolve) => setTimeout(resolve, 16))
    await swipe([12, 12])
    expect(played[0].cancelled).toBe(true)
    expect(push).not.toHaveBeenCalled()
    // Caught partway: neither where it started nor where it was going.
    const caught = Number(/translate3d\((-?[\d.]+)px/.exec(track().style.transform)![1])
    expect(caught).toBeLessThan(0)
    expect(caught).toBeGreaterThan(-window.innerWidth)
  })

  it("switches at once when the reader asks for less motion", () => {
    reduceMotion(true)
    renderStage()
    act(() => switchDevice("dev_1"))
    expect(window.location.pathname).toBe("/d/dev_1/")
  })
})
