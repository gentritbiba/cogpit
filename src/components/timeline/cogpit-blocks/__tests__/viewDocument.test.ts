import { describe, expect, it } from "vitest"
import { isFenceClosed } from "../kinds"
import { composeViewDocument, librariesUsed, readViewMessage, viewTitle } from "../view/document"

const THEME = { mode: "dark" as const, tokens: { "--primary": "oklch(0.7 0.1 250)", "--font-sans": "\"Inter\", sans-serif" } }

describe("isFenceClosed", () => {
  it("is true only once the closing fence has been written", () => {
    expect(isFenceClosed("```cogpit-view\n<p>hi</p>\n```")).toBe(true)
    expect(isFenceClosed("```cogpit-view\n<p>hi</p>\n```\n")).toBe(true)
    expect(isFenceClosed("```cogpit-view\n<p>hi</p>")).toBe(false)
    expect(isFenceClosed("```cogpit-view")).toBe(false)
  })

  it("needs a closing fence of the same kind and at least the same length", () => {
    expect(isFenceClosed("````cogpit-view\n```\n````")).toBe(true)
    expect(isFenceClosed("````cogpit-view\n<p>x</p>\n```")).toBe(false)
    expect(isFenceClosed("~~~cogpit-view\n<p>x</p>\n```")).toBe(false)
  })

  it("reads fences nested in a list or quote", () => {
    expect(isFenceClosed("  ```cogpit-view\n  <p>x</p>\n  ```")).toBe(true)
    expect(isFenceClosed("> ```cogpit-view\n> <p>x</p>\n> ```")).toBe(true)
  })
})

describe("librariesUsed", () => {
  it("finds the libraries a view loads by name", () => {
    expect([...librariesUsed(`<script src="cogpit:lib/d3"></script><script src="cogpit:lib/katex"></script>`)]).toEqual(["d3", "katex"])
    expect(librariesUsed(`<script src="cogpit:lib/leftpad"></script>`).size).toBe(0)
  })

  it("brings Three.js with its core and controls for a bare import", () => {
    const used = librariesUsed(`<script type="module">import * as THREE from "three"</script>`)
    expect([...used].sort()).toEqual(["three", "three-core", "three-orbit-controls"])
    expect(librariesUsed(`<p>three little pigs</p>`).size).toBe(0)
  })
})

describe("viewTitle", () => {
  it("reads the title the view gives itself", () => {
    expect(viewTitle("<title>  Gradient\n descent </title><p>x</p>")).toBe("Gradient descent")
    expect(viewTitle("<p>no title</p>")).toBeNull()
    expect(viewTitle("<title></title>")).toBeNull()
  })
})

describe("composeViewDocument", () => {
  it("puts the agent's markup in the body after Cogpit's head", () => {
    const html = composeViewDocument("<p id=agent>hello</p>", THEME, new Set())
    const head = html.slice(0, html.indexOf("<body>"))
    expect(head).toContain("window.cogpit = Object.freeze")
    expect(head).not.toContain("importmap")
    expect(html.endsWith("<body><p id=agent>hello</p></body></html>")).toBe(true)
  })

  it("maps Three.js imports only when the view uses it", () => {
    const html = composeViewDocument("", THEME, librariesUsed(`import * as THREE from "three"`))
    expect(html).toContain(`<script type="importmap">{"imports":{"three":"cogpit:lib/three","three/core":"cogpit:lib/three-core"`)
  })

  it("keeps theme values from closing the script they are embedded in", () => {
    const html = composeViewDocument("", { mode: "light", tokens: { "--font-sans": "</script><script>alert(1)</script>" } }, new Set())
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain("\\u003c/script>")
  })
})

describe("readViewMessage", () => {
  const view = (message: Record<string, unknown>) => readViewMessage({ cogpitView: 1, ...message })

  it("ignores anything that is not a view message", () => {
    expect(readViewMessage(null)).toBeNull()
    expect(readViewMessage({ type: "ready" })).toBeNull()
    expect(view({ type: "navigate" })).toBeNull()
  })

  it("accepts finite sizes only", () => {
    expect(view({ type: "resize", height: 320 })).toEqual({ type: "resize", height: 320 })
    expect(view({ type: "resize", height: Number.POSITIVE_INFINITY })).toBeNull()
    expect(view({ type: "resize", height: -1 })).toBeNull()
    expect(view({ type: "resize", height: "320" })).toBeNull()
  })

  it("opens plain web links only", () => {
    expect(view({ type: "open", href: "https://example.test/a" })).toEqual({ type: "open", href: "https://example.test/a" })
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.test/", "not a url"]) {
      expect(view({ type: "open", href })).toBeNull()
    }
  })

  it("bounds the text a view asks with and the errors it reports", () => {
    expect(view({ type: "ask", text: "   " })).toBeNull()
    expect((view({ type: "ask", text: "x".repeat(5000) }) as { text: string }).text).toHaveLength(4000)
    expect((view({ type: "error", message: "e".repeat(1000) }) as { message: string }).message).toHaveLength(600)
  })
})
