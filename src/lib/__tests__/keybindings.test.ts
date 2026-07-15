import { beforeEach, describe, expect, it } from "vitest"
import {
  findKeybindingConflict,
  getKeybinding,
  matchesKeybinding,
  resetAllKeybindings,
  setKeybinding,
  shortcutFromKeyboardEvent,
} from "@/lib/keybindings"

function event(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init })
}

describe("keybindings", () => {
  beforeEach(() => {
    resetAllKeybindings()
  })

  it("matches default mod shortcuts with either Meta or Control", () => {
    expect(matchesKeybinding("commandPalette", event("k", { metaKey: true }))).toBe(true)
    expect(matchesKeybinding("commandPalette", event("k", { ctrlKey: true }))).toBe(true)
    expect(matchesKeybinding("commandPalette", event("k"))).toBe(false)
  })

  it("keeps workspace and context shortcuts in the centralized registry", () => {
    expect(matchesKeybinding("projectFiles", event("f", { metaKey: true, shiftKey: true }))).toBe(true)
    expect(matchesKeybinding("projectFileSave", event("s", { ctrlKey: true }))).toBe(true)
    expect(matchesKeybinding("previewZoomIn", event("=", { metaKey: true }))).toBe(true)
  })

  it("persists and matches a custom shortcut", () => {
    setKeybinding("commandPalette", { key: "p", ctrlKey: true, shiftKey: true })

    expect(getKeybinding("commandPalette")).toEqual({
      key: "p",
      ctrlKey: true,
      shiftKey: true,
    })
    expect(matchesKeybinding("commandPalette", event("p", { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matchesKeybinding("commandPalette", event("k", { ctrlKey: true }))).toBe(false)
  })

  it("detects conflicts with effective bindings", () => {
    expect(findKeybindingConflict({ key: "j", modKey: true }, "commandPalette")?.command)
      .toBe("integratedTerminal")
  })

  it("records the physical modifier combination from a keyboard event", () => {
    expect(shortcutFromKeyboardEvent(event("P", { metaKey: true, altKey: true }))).toEqual({
      key: "p",
      metaKey: true,
      ctrlKey: undefined,
      shiftKey: undefined,
      altKey: true,
    })
  })
})
