import { afterEach, describe, expect, it, vi } from "vitest"
import { PLUGIN_SHELL_HTML } from "../../../server/plugins/shell"
import { parsePluginContext } from "@cogpit/plugin-contracts"
import { PLUGIN_THEME_TOKENS, readPluginPresentation } from "../runtimeContext"

afterEach(() => {
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("data-reduced-motion")
})

describe("host-owned plugin presentation", () => {
  it("applies the theme before entry code runs and clears it across mode and context changes", () => {
    const windowListeners = new Map<string, (event: unknown) => void>()
    const listeners = new Set<(event: unknown) => void>()
    const port = {
      addEventListener: (_: string, listener: (event: unknown) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: unknown) => void) => listeners.delete(listener),
      postMessage: vi.fn(), start: vi.fn(), close: vi.fn(),
    }
    const parent = {}
    const window = { parent, addEventListener: (name: string, listener: (event: unknown) => void) => windowListeners.set(name, listener) }
    const script = PLUGIN_SHELL_HTML.match(/<script>([\s\S]+)<\/script>/)![1]
    new Function("window", "document", "URL", script)(window, document, { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() })
    windowListeners.get("message")!({ source: parent, data: { type: "cogpit-plugin-connect", nonce: "a".repeat(64) }, ports: [port] })
    const send = (data: unknown) => { for (const listener of [...listeners]) listener({ data }) }
    const theme = { mode: "dark", tokens: { "--canvas": "#000", "--surface": "rgb(255 255 255 / 3%)" } }
    document.documentElement.style.setProperty("--plugin-private", "10px")
    send({ type: "cogpit-plugin-load", assets: [], style: null, entry: "", context: { theme, locale: "en", reducedMotion: false } })
    expect(document.documentElement).toHaveClass("dark", "theme-layered")
    expect(document.documentElement.style.getPropertyValue("--canvas")).toBe("#000")
    send({ protocol: 1, type: "event", event: "theme", value: { mode: "light", tokens: { "--canvas": "#fff", "--surface": "rgb(0 0 0 / 3%)" } } })
    expect(document.documentElement).toHaveClass("theme-layered")
    expect(document.documentElement).not.toHaveClass("dark")
    expect(document.documentElement.style.colorScheme).toBe("light")
    send({ protocol: 1, type: "event", event: "context", value: { theme: { mode: "light", tokens: { "--canvas": "white" } }, locale: "fr", reducedMotion: true } })
    expect(document.documentElement).not.toHaveClass("theme-layered")
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--plugin-private")).toBe("10px")
    expect(document.documentElement.lang).toBe("fr")
    expect(document.documentElement.dataset.reducedMotion).toBe("true")
    document.body.querySelector('script[src="blob:test"]')?.remove()
  })

  it("exports the shared color contract, including editors and sidebars, within the plugin protocol", () => {
    expect(PLUGIN_THEME_TOKENS).toEqual(expect.arrayContaining(["--canvas", "--selection", "--prompt-surface", "--composer-surface", "--sidebar", "--sidebar-border"]))
    expect(new Set(PLUGIN_THEME_TOKENS).size).toBe(PLUGIN_THEME_TOKENS.length)
    for (const name of PLUGIN_THEME_TOKENS) document.documentElement.style.setProperty(name, "#000")
    expect(() => parsePluginContext({ ...readPluginPresentation(), project: null, visible: true })).not.toThrow()
  })
})
