import { act, renderHook, cleanup, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
}))
vi.mock("@/lib/auth", () => auth)

import { useTheme } from "../useTheme"
import { DevicePaneProvider } from "@/contexts/DevicePaneContext"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetDeviceThemesForTest, keepsOwnDeviceTheme, localOnlyDeviceTheme, savedDeviceTheme } from "@/lib/deviceThemes"
import { applyTheme } from "@/lib/themes"

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function inPane(deviceId: string) {
  return ({ children }: { children: ReactNode }) => createElement(DevicePaneProvider, { value: deviceId }, children)
}

function putBodies(): unknown[] {
  return auth.authFetch.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(init.body as string))
}

beforeEach(() => {
  localStorage.clear()
  __resetDeviceThemesForTest()
  __resetCapabilitiesForTest()
  auth.authFetch.mockReset()
  auth.isRemoteClient.mockReturnValue(false)
  document.documentElement.className = "electron"
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute("style")
  document.querySelector('meta[name="theme-color"]')?.remove()
  localStorage.clear()
  document.documentElement.className = ""
})

describe("useTheme outside a machine's pane (a shared session)", () => {
  it("dresses the document and the browser chrome in this browser's theme and its previews", () => {
    document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#111">')
    localStorage.setItem("cogpit-theme", "layered-light")
    __resetDeviceThemesForTest()
    const { result } = renderHook(useTheme)
    expect(document.documentElement).toHaveClass("electron", "theme-layered")
    expect(document.documentElement.style.colorScheme).toBe("light")
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff")
    act(() => result.current.setPreview("layered"))
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#000000")
    act(() => result.current.setPreview(null))
    expect(document.documentElement).not.toHaveClass("dark")
  })

  it("keeps a pick in this browser without asking any machine", () => {
    const { result } = renderHook(useTheme)
    act(() => result.current.setTheme("oled"))
    expect(document.documentElement).toHaveClass("dark", "theme-oled")
    expect(savedDeviceTheme("local")).toBe("oled")
    expect(auth.authFetch).not.toHaveBeenCalled()
  })

  it("still changes themes when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked") })
    __resetDeviceThemesForTest()
    const { result } = renderHook(useTheme)
    expect(result.current.theme).toBe("dark")
    act(() => result.current.setTheme("layered-light"))
    expect(document.documentElement).toHaveClass("theme-layered")
    expect(document.documentElement).not.toHaveClass("dark")
  })
})

describe("useTheme in a machine's pane", () => {
  it("wears the theme the machine reports and leaves the document to DeviceRoot", async () => {
    applyTheme("dark")
    auth.authFetch.mockResolvedValue(json(200, { theme: "layered-light" }))
    const { result } = renderHook(useTheme, { wrapper: inPane("dev_a") })
    await waitFor(() => expect(result.current.theme).toBe("layered-light"))
    expect(auth.authFetch).toHaveBeenCalledWith("/api/appearance", expect.objectContaining({ background: true }))
    expect(document.documentElement).toHaveClass("dark")
  })

  it("asks the machine to wear a pick, for every computer that opens it", async () => {
    auth.authFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(json(200, init?.method === "PUT" ? JSON.parse(init.body as string) : { theme: "dark" })))
    const { result } = renderHook(useTheme, { wrapper: inPane("dev_a") })
    await waitFor(() => expect(auth.authFetch).toHaveBeenCalled())
    act(() => result.current.setTheme("oled"))
    expect(result.current.theme).toBe("oled")
    await waitFor(() => expect(putBodies()).toEqual([{ theme: "oled" }]))
    expect(localOnlyDeviceTheme("dev_a")).toBeNull()
  })

  it("keeps the pick on this computer when the machine is too old to keep one", async () => {
    auth.authFetch.mockResolvedValue(new Response("", { status: 404 }))
    const { result } = renderHook(useTheme, { wrapper: inPane("dev_old") })
    act(() => result.current.setTheme("light"))
    await waitFor(() => expect(localOnlyDeviceTheme("dev_old")).toBe("light"))
    expect(result.current.theme).toBe("light")
  })

  it("follows the machine again once a pick it was too old to keep is behind it", async () => {
    auth.authFetch.mockResolvedValue(new Response("", { status: 404 }))
    const { result, unmount } = renderHook(useTheme, { wrapper: inPane("dev_a") })
    act(() => result.current.setTheme("oled"))
    await waitFor(() => expect(localOnlyDeviceTheme("dev_a")).toBe("oled"))
    unmount()

    // The machine was updated and someone gave it a theme.
    auth.authFetch.mockResolvedValue(json(200, { theme: "light" }))
    const again = renderHook(useTheme, { wrapper: inPane("dev_a") })
    await waitFor(() => expect(again.result.current.theme).toBe("light"))
  })

  it("lets no read that started before a pick land over it or hand the machine an older theme", async () => {
    localStorage.setItem("cogpit-theme", "light")
    __resetDeviceThemesForTest()
    let answerRead!: (response: Response) => void
    auth.authFetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? Promise.resolve(json(200, JSON.parse(init.body as string)))
        : new Promise<Response>((resolve) => { answerRead = resolve }))
    const { result } = renderHook(useTheme, { wrapper: inPane("local") })
    await waitFor(() => expect(answerRead).toBeDefined())

    act(() => result.current.setTheme("oled"))
    await waitFor(() => expect(putBodies()).toEqual([{ theme: "oled" }]))
    await act(async () => answerRead(json(200, { theme: null })))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(putBodies()).toEqual([{ theme: "oled" }])
    expect(result.current.theme).toBe("oled")
  })

  it("gives a machine without a theme the one its own window wore before", async () => {
    localStorage.setItem("cogpit-theme", "layered")
    __resetDeviceThemesForTest()
    auth.authFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(json(200, init?.method === "PUT" ? JSON.parse(init.body as string) : { theme: null })))
    renderHook(useTheme, { wrapper: inPane("local") })
    await waitFor(() => expect(putBodies()).toEqual([{ theme: "layered" }]))
  })

  it("does not hand a machine this computer's old theme from afar", async () => {
    localStorage.setItem("cogpit-theme", "layered")
    __resetDeviceThemesForTest()
    auth.authFetch.mockResolvedValue(json(200, { theme: null }))
    renderHook(useTheme, { wrapper: inPane("dev_a") })
    await waitFor(() => expect(auth.authFetch).toHaveBeenCalledTimes(1))
    auth.isRemoteClient.mockReturnValue(true)
    renderHook(useTheme, { wrapper: inPane("local") })
    await waitFor(() => expect(auth.authFetch).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(putBodies()).toEqual([])
  })

  it("lets an account the machine refuses keep its own pick", async () => {
    auth.authFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "PUT" ? new Response("", { status: 403 }) : json(200, { theme: "light" })))
    const { result } = renderHook(useTheme, { wrapper: inPane("dev_a") })
    await waitFor(() => expect(result.current.theme).toBe("light"))
    act(() => result.current.setTheme("oled"))
    await waitFor(() => expect(keepsOwnDeviceTheme("dev_a")).toBe(true))
    act(() => { window.dispatchEvent(new Event("focus")) })
    await waitFor(() => expect(auth.authFetch.mock.calls.filter(([, init]) => !init?.method).length).toBe(2))
    expect(result.current.theme).toBe("oled")
  })
})
