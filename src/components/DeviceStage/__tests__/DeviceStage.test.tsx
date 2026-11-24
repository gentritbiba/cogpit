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

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }))
}

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
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

  it("slides an explicit switch to a machine not opened yet past its poster, then commits it", async () => {
    reduceMotion(false)
    renderStage()
    act(() => switchDevice("dev_1"))
    expect(window.location.pathname).toBe("/")
    expect(screen.getByText("Studio", { selector: "span.text-sm" })).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe("/d/dev_1/"), { timeout: 3000 })
    expect(screen.getByRole("status")).toHaveTextContent("Now on Studio")
  })

  it("drops a slide that Back overtook instead of adding the machine to history again", async () => {
    reduceMotion(false)
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
  })

  it("switches at once when the reader asks for less motion", () => {
    reduceMotion(true)
    renderStage()
    act(() => switchDevice("dev_1"))
    expect(window.location.pathname).toBe("/d/dev_1/")
  })
})
