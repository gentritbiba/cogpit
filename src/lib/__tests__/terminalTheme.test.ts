import { afterEach, describe, expect, it } from "vitest"
import { readTerminalTheme } from "../terminalTheme"

afterEach(() => document.documentElement.removeAttribute("style"))

describe("terminal theme", () => {
  it("reads the active CSS colors again after a theme change", () => {
    const root = document.documentElement
    root.style.setProperty("--foreground", "#fafafa")
    root.style.setProperty("--terminal-black", "#171717")
    root.style.setProperty("--terminal-white", "#fafafa")
    root.style.setProperty("--terminal-magenta", "#b83ba4")
    root.style.setProperty("--terminal-cyan", "#008fa3")
    root.style.setProperty("--canvas", "#000")
    root.style.setProperty("--terminal-selection", "#333")
    root.style.setProperty("--destructive", "#f00")
    expect(readTerminalTheme(root)).toMatchObject({ background: "#00000000", foreground: "#fafafa", cursor: "#fafafa", cursorAccent: "#000", selectionBackground: "#333", red: "#f00", black: "#171717", white: "#fafafa", magenta: "#b83ba4", cyan: "#008fa3" })
    root.style.setProperty("--foreground", "#171717")
    root.style.setProperty("--canvas", "#fff")
    expect(readTerminalTheme(root)).toMatchObject({ foreground: "#171717", cursor: "#171717", cursorAccent: "#fff", black: "#171717", white: "#fafafa", magenta: "#b83ba4", cyan: "#008fa3" })
  })
})
