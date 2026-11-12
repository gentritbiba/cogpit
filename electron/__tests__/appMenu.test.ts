// @vitest-environment node
import type { MenuItemConstructorOptions } from "electron"
import { describe, expect, it, vi } from "vitest"
import { appMenuTemplate } from "../appMenu"
import { DOCUMENTATION_URL, REPORT_ISSUE_URL } from "../../shared/helpLinks"

function helpMenu(platform: NodeJS.Platform, actions = { openExternal: vi.fn(), openKeyboardShortcuts: vi.fn() }) {
  const help = appMenuTemplate(platform, actions).find((menu) => menu.role === "help")
  const items = (help?.submenu ?? []) as MenuItemConstructorOptions[]
  const click = (label: string) => (items.find((item) => item.label === label)?.click as () => void)()
  return { items, click, actions }
}

describe("appMenuTemplate", () => {
  it("adds a Help menu with the docs, the shortcuts and the issue tracker", () => {
    const { items, click, actions } = helpMenu("darwin")

    expect(items.filter((item) => item.label).map((item) => item.label))
      .toEqual(["Documentation", "Keyboard Shortcuts", "Report an Issue"])

    click("Documentation")
    click("Report an Issue")
    click("Keyboard Shortcuts")

    expect(actions.openExternal.mock.calls).toEqual([[DOCUMENTATION_URL], [REPORT_ISSUE_URL]])
    expect(actions.openKeyboardShortcuts).toHaveBeenCalledOnce()
    expect(DOCUMENTATION_URL).toBe("https://github.com/gentritbiba/cogpit#readme")
    expect(REPORT_ISSUE_URL).toBe("https://github.com/gentritbiba/cogpit/issues/new")
  })

  it("keeps Windows on a File menu without the macOS-only zoom role", () => {
    const template = appMenuTemplate("win32", { openExternal: vi.fn(), openKeyboardShortcuts: vi.fn() })

    expect(template[0]).toMatchObject({ label: "File" })
    const windowMenu = template.find((menu) => menu.label === "Window")
    expect((windowMenu?.submenu as MenuItemConstructorOptions[]).map((item) => item.role)).toEqual(["minimize", "close"])
    expect(template.some((menu) => menu.role === "help")).toBe(true)
  })
})
