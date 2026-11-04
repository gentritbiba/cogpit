// @vitest-environment node
import { describe, expect, it } from "vitest"
import { loadingPageUrl } from "../loadingPage"

function decode(url: string): string {
  const prefix = "data:text/html;charset=utf-8,"
  expect(url.startsWith(prefix)).toBe(true)
  return decodeURIComponent(url.slice(prefix.length))
}

describe("loadingPageUrl", () => {
  it("is a self-contained page on the window's own background", () => {
    const html = decode(loadingPageUrl(null))

    expect(html).toContain("<title>Cogpit</title>")
    expect(html).toContain("Starting Cogpit…")
    expect(html).toContain("background: #09090b")
    expect(html).not.toMatch(/(src|href)="https?:/)
    expect(html).not.toContain("<img")
  })

  it("shows the app mark when it is available", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    const html = decode(loadingPageUrl(svg))

    expect(html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"`)
  })
})
