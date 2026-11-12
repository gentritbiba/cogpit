import { afterEach, describe, expect, it, vi } from "vitest"

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
  listen: vi.fn(),
  startDragging: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
}))

vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauri.isTauri, invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: tauri.startDragging, toggleMaximize: tauri.toggleMaximize }),
}))

import { desktopPlatform, dragWindow, installDesktopBridge } from "../bridge"

afterEach(() => {
  delete window.cogpitDesktop
  document.documentElement.className = ""
  document.body.innerHTML = ""
  vi.clearAllMocks()
  tauri.isTauri.mockReturnValue(false)
})

describe("desktopPlatform", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "macos"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", "linux"],
  ])("reads %s as %s", (userAgent, platform) => {
    expect(desktopPlatform(userAgent)).toBe(platform)
  })
})

describe("installDesktopBridge", () => {
  it("leaves a browser untouched", () => {
    installDesktopBridge()
    expect(window.cogpitDesktop).toBeUndefined()
    expect(document.documentElement.className).toBe("")
  })

  it("exposes the shell's commands and marks the page in the desktop app", async () => {
    tauri.isTauri.mockReturnValue(true)
    const snapshot = { capturedAt: 1, processes: [] }
    tauri.invoke.mockResolvedValue(snapshot)

    installDesktopBridge()

    const platform = desktopPlatform(navigator.userAgent)
    expect(window.cogpitDesktop?.platform).toBe(platform)
    expect(document.documentElement).toHaveClass("desktop", `desktop-${platform}`)
    await expect(window.cogpitDesktop?.performance.getSnapshot()).resolves.toEqual(snapshot)
    expect(tauri.invoke).toHaveBeenCalledWith("performance_snapshot")
  })
})

describe("the updater", () => {
  function install(): DesktopUpdater {
    tauri.isTauri.mockReturnValue(true)
    installDesktopBridge()
    return window.cogpitDesktop!.updater
  }

  it("reads the state, installs and dismisses through the shell", async () => {
    const ready: DesktopUpdateState = { status: "ready", version: "4.0.0", asksForPassword: false }
    tauri.invoke.mockResolvedValue(ready)
    const updater = install()

    await expect(updater.getState()).resolves.toEqual(ready)
    expect(tauri.invoke).toHaveBeenLastCalledWith("update_state")
    await updater.install()
    expect(tauri.invoke).toHaveBeenLastCalledWith("update_install")
    updater.dismissVersion("4.0.0")
    expect(tauri.invoke).toHaveBeenLastCalledWith("update_dismiss", { version: "4.0.0" })
  })

  it("passes on every state the shell announces until unsubscribed", async () => {
    const stop = vi.fn()
    tauri.listen.mockResolvedValue(stop)
    const states: DesktopUpdateState[] = []

    const unsubscribe = install().onState((state) => states.push(state))

    expect(tauri.listen).toHaveBeenCalledWith("update-state", expect.any(Function))
    const announced: DesktopUpdateState = { status: "available", version: "4.0.0", url: "https://example.test", via: "download" }
    tauri.listen.mock.calls[0][1]({ payload: announced })
    expect(states).toEqual([announced])

    unsubscribe()
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
  })
})

describe("dragWindow", () => {
  function press(target: Element, detail = 1, button = 0): MouseEvent {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail, button })
    Object.defineProperty(event, "target", { value: target })
    dragWindow(event)
    return event
  }

  function header(): { region: HTMLElement; button: HTMLButtonElement; label: HTMLElement } {
    document.body.innerHTML = `<div class="desktop-drag"><span>Cogpit</span><button><svg></svg></button></div><p>text</p>`
    return {
      region: document.querySelector(".desktop-drag")!,
      button: document.querySelector("button")!,
      label: document.querySelector("span")!,
    }
  }

  it("drags the window from a drag region and anything plain inside it", () => {
    const { region, label } = header()
    expect(press(region).defaultPrevented).toBe(true)
    press(label)
    expect(tauri.startDragging).toHaveBeenCalledTimes(2)
  })

  it("zooms the window on a double click, as a title bar does", () => {
    press(header().region, 2)
    expect(tauri.toggleMaximize).toHaveBeenCalledOnce()
    expect(tauri.startDragging).not.toHaveBeenCalled()
  })

  it("leaves controls, other buttons and the rest of the page alone", () => {
    const { button, region } = header()
    expect(press(button.querySelector("svg")!).defaultPrevented).toBe(false)
    press(document.querySelector("p")!)
    press(region, 1, 2)
    expect(tauri.startDragging).not.toHaveBeenCalled()
  })

  it("drags from the strip standing in for the title bar", () => {
    document.body.innerHTML = `<div class="drag-strip"></div>`
    press(document.querySelector(".drag-strip")!)
    expect(tauri.startDragging).toHaveBeenCalledOnce()
  })
})
