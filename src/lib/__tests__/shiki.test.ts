// @vitest-environment node
import { describe, it, expect } from "vitest"
import { getLangFromPath, EXT_TO_LANG } from "../shiki"

describe("getLangFromPath", () => {
  it("returns correct language for common extensions", () => {
    expect(getLangFromPath("file.ts")).toBe("typescript")
    expect(getLangFromPath("file.tsx")).toBe("tsx")
    expect(getLangFromPath("file.js")).toBe("javascript")
    expect(getLangFromPath("file.py")).toBe("python")
    expect(getLangFromPath("file.json")).toBe("json")
    expect(getLangFromPath("file.css")).toBe("css")
    expect(getLangFromPath("file.html")).toBe("html")
    expect(getLangFromPath("file.md")).toBe("markdown")
    expect(getLangFromPath("file.yml")).toBe("yaml")
    expect(getLangFromPath("file.sh")).toBe("bash")
  })

  it("handles nested paths", () => {
    expect(getLangFromPath("src/components/App.tsx")).toBe("tsx")
    expect(getLangFromPath("/home/user/project/main.py")).toBe("python")
  })

  it("returns null for unknown extensions", () => {
    expect(getLangFromPath("file.xyz")).toBeNull()
    expect(getLangFromPath("file")).toBeNull()
  })

  it("is case-insensitive for extensions", () => {
    expect(getLangFromPath("file.TS")).toBe("typescript")
    expect(getLangFromPath("file.PY")).toBe("python")
  })
})

describe("EXT_TO_LANG", () => {
  it("maps TypeScript variants correctly", () => {
    expect(EXT_TO_LANG["ts"]).toBe("typescript")
    expect(EXT_TO_LANG["tsx"]).toBe("tsx")
    expect(EXT_TO_LANG["mts"]).toBe("typescript")
    expect(EXT_TO_LANG["cts"]).toBe("typescript")
  })

  it("maps JavaScript variants correctly", () => {
    expect(EXT_TO_LANG["js"]).toBe("javascript")
    expect(EXT_TO_LANG["jsx"]).toBe("jsx")
    expect(EXT_TO_LANG["mjs"]).toBe("javascript")
    expect(EXT_TO_LANG["cjs"]).toBe("javascript")
  })
})
