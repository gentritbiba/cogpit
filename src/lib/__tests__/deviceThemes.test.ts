import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetDeviceThemesForTest,
  keepsOwnDeviceTheme,
  localOnlyDeviceTheme,
  previewDeviceTheme,
  rememberDeviceTheme,
  savedDeviceTheme,
  shownDeviceTheme,
  subscribeDeviceThemes,
} from "../deviceThemes"

describe("deviceThemes", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetDeviceThemesForTest()
  })

  it("falls back to the theme this browser used before machines had their own", () => {
    expect(savedDeviceTheme("dev_a")).toBe("dark")
    localStorage.setItem("cogpit-theme", "oled")
    expect(savedDeviceTheme("dev_a")).toBe("oled")
  })

  it("keeps each machine's theme apart and survives a reload", () => {
    rememberDeviceTheme("local", "layered", "host")
    rememberDeviceTheme("dev_a", "light", "host")
    __resetDeviceThemesForTest()
    expect(savedDeviceTheme("local")).toBe("layered")
    expect(savedDeviceTheme("dev_a")).toBe("light")
  })

  it("marks a pick only this browser keeps, and why, until the machine keeps one", () => {
    rememberDeviceTheme("dev_a", "oled", "unsupported")
    expect(localOnlyDeviceTheme("dev_a")).toBe("oled")
    expect(keepsOwnDeviceTheme("dev_a")).toBe(false)
    rememberDeviceTheme("dev_a", "oled", "forbidden")
    expect(keepsOwnDeviceTheme("dev_a")).toBe(true)
    rememberDeviceTheme("dev_a", "oled", "host")
    expect(localOnlyDeviceTheme("dev_a")).toBeNull()
  })

  it("shows a preview over the saved theme without saving it", () => {
    rememberDeviceTheme("dev_a", "light", "host")
    previewDeviceTheme("dev_a", "oled")
    expect(shownDeviceTheme("dev_a")).toBe("oled")
    expect(savedDeviceTheme("dev_a")).toBe("light")
    expect(shownDeviceTheme("local")).toBe("dark")
    previewDeviceTheme("dev_a", null)
    expect(shownDeviceTheme("dev_a")).toBe("light")
  })

  it("tells subscribers only about real changes", () => {
    const listener = vi.fn()
    const off = subscribeDeviceThemes(listener)
    rememberDeviceTheme("dev_a", "light", "host")
    rememberDeviceTheme("dev_a", "light", "host")
    previewDeviceTheme("dev_a", null)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it("ignores entries a newer or broken build left behind", () => {
    localStorage.setItem("cogpit-device-themes", JSON.stringify({ dev_a: { theme: "neon" }, dev_b: { theme: "light", local: "forbidden" }, dev_c: { theme: "oled", local: "sideways" } }))
    __resetDeviceThemesForTest()
    expect(savedDeviceTheme("dev_a")).toBe("dark")
    expect(keepsOwnDeviceTheme("dev_b")).toBe(true)
    expect(localOnlyDeviceTheme("dev_c")).toBeNull()
  })
})
