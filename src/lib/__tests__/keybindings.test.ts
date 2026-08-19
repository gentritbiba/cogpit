import { beforeEach, describe, expect, it } from "vitest"
import {
  DEVICE_SWITCH_COMMANDS,
  KEYBINDING_DEFINITIONS,
  findKeybindingConflict,
  getKeybinding,
  isEditableTarget,
  matchDeviceSwitchIndex,
  matchesKeybinding,
  resetAllKeybindings,
  setKeybinding,
  shortcutFromKeyboardEvent,
  shortcutLabel,
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
    expect(matchesKeybinding("expandAll", event("e", { metaKey: true }))).toBe(true)
    expect(matchesKeybinding("expandAll", event("e", { metaKey: true, shiftKey: true }))).toBe(false)
    expect(matchesKeybinding("expandToolPayloads", event("e", { metaKey: true, shiftKey: true }))).toBe(true)
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

  it("keeps device switching off mod+shift+digit so it cannot double-fire with the live-session jump", () => {
    // mod+shift+1..9 belongs to "jump to the Nth live session" (matched on
    // event.code in useKeyboardShortcuts). Devices moved to the platform chord.
    expect(matchDeviceSwitchIndex(event("1", { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchDeviceSwitchIndex(event("2", { ctrlKey: true, shiftKey: true }))).toBeNull()

    expect(matchDeviceSwitchIndex(event("1", { ctrlKey: true, metaKey: true }))).toBe(1)
    expect(matchDeviceSwitchIndex(event("2", { ctrlKey: true, altKey: true }))).toBe(2)
  })

  it("registers the shortcuts that used to be raw window listeners", () => {
    expect(matchesKeybinding("findInConversation", event("f", { metaKey: true }))).toBe(true)
    expect(matchesKeybinding("findInConversation", event("f", { metaKey: true, shiftKey: true }))).toBe(false)
    expect(matchesKeybinding("focusComposer", event(" "))).toBe(true)
    expect(matchesKeybinding("focusComposer", event(" ", { metaKey: true }))).toBe(false)
    expect(matchesKeybinding("nextLiveSession", event("ArrowDown", { metaKey: true, shiftKey: true }))).toBe(true)
    expect(matchesKeybinding("prevLiveSession", event("ArrowUp", { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matchesKeybinding("recentSessionBack", event("Tab", { ctrlKey: true }))).toBe(true)
    expect(matchesKeybinding("recentSessionForward", event("Tab", { ctrlKey: true, shiftKey: true }))).toBe(true)
    // Cmd+Tab is the macOS app switcher and must never reach the MRU handler.
    expect(matchesKeybinding("recentSessionBack", event("Tab", { metaKey: true }))).toBe(false)
    expect(matchesKeybinding("keyboardShortcuts", event("?", { shiftKey: true }))).toBe(true)
  })

  it("gives every definition a human-readable shortcut label", () => {
    for (const definition of KEYBINDING_DEFINITIONS) {
      // Raw event.key tokens ("arrowdown", "tab") must never reach the UI.
      expect(shortcutLabel(definition.command)).not.toMatch(/arrowdown|arrowup|\btab\b|escape/)
    }
    expect(shortcutLabel("nextLiveSession")).toContain("↓")
    expect(shortcutLabel("recentSessionForward")).toContain("Tab")
    expect(shortcutLabel("focusComposer")).toBe("Space")
    expect(shortcutLabel(DEVICE_SWITCH_COMMANDS[0])).toMatch(/1$/)
  })

  it("defines no duplicate default chords", () => {
    for (const definition of KEYBINDING_DEFINITIONS) {
      expect(findKeybindingConflict(definition.defaultShortcut, definition.command)).toBeNull()
    }
  })

  it("treats text entry surfaces as editable targets", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true)
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true)
    expect(isEditableTarget(document.createElement("div"))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
