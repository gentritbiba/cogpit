import { afterEach, describe, expect, it, vi } from "vitest"
import { VIEW_FRAME_KIT, VIEW_THEME_TOKEN } from "../../../../../shared/views/frame"
import { publishedViewDocument, validThemeTokens } from "../../../../../shared/views/publish"

const themes = { light: { "--card": "white" }, dark: { "--card": "black" } }

/** The expression a published page passes the kit instead of a viewer's theme. */
function themeExpression(): string {
  const html = publishedViewDocument(`<script>(kit)(${VIEW_THEME_TOKEN})</script>`, themes)
  return html.slice("<script>(kit)(".length, -")</script>".length)
}

function stubColorScheme(dark: boolean) {
  const listeners: Array<() => void> = []
  const query = { matches: dark, addEventListener: (_type: string, listener: () => void) => listeners.push(listener) }
  vi.stubGlobal("matchMedia", vi.fn(() => query))
  return { flip(next: boolean) { query.matches = next; for (const listener of listeners) listener() } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("publishedViewDocument", () => {
  it("starts in the visitor's light or dark setting and follows it when it changes", () => {
    const scheme = stubColorScheme(true)
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {})
    expect(new Function(`return ${themeExpression()}`)()).toEqual({ mode: "dark", tokens: { "--card": "black" } })
    scheme.flip(false)
    expect(post).toHaveBeenCalledWith({ type: "cogpit-view:theme", theme: { mode: "light", tokens: { "--card": "white" } } }, "*")
  })

  it("leaves a page without the placeholder as it was, and keeps the tokens out of the markup", () => {
    expect(publishedViewDocument("<p>plain</p>", themes)).toBe("<p>plain</p>")
    const html = publishedViewDocument(`<script>(kit)(${VIEW_THEME_TOKEN})</script>`, { light: { "--x": "</script><b>" }, dark: {} })
    expect(html).not.toContain("</script><b>")
  })
})

describe("the frame kit on its own page", () => {
  it("lets links open normally when no Cogpit window frames it", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
    vi.spyOn(window, "postMessage").mockImplementation(() => {})
    new Function(`(${VIEW_FRAME_KIT})({ mode: "light", tokens: {} })`)()
    const link = Object.assign(document.createElement("a"), { href: "https://example.com/" })
    document.body.append(link)
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    link.addEventListener("click", (event) => event.preventDefault())
    const intercepted = vi.spyOn(click, "preventDefault")
    link.dispatchEvent(click)
    expect(window.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "open" }), "*")
    expect(intercepted).toHaveBeenCalledTimes(1)
    link.remove()
  })
})

describe("validThemeTokens", () => {
  it("takes plain custom properties and refuses anything that could break out of a style", () => {
    expect(validThemeTokens({ "--card": "oklch(1 0 0)", "--font-sans": "\"Geist\", sans-serif" })).toEqual({ "--card": "oklch(1 0 0)", "--font-sans": "\"Geist\", sans-serif" })
    for (const value of [{ color: "red" }, { "--x": "red; background: url(x)" }, { "--x": "a".repeat(257) }, { "--x": 1 }, [], null,
      Object.fromEntries(Array.from({ length: 97 }, (_, index) => [`--t${index}`, "1"]))]) expect(validThemeTokens(value)).toBeNull()
  })
})
