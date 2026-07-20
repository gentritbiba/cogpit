import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import ReactMarkdown from "react-markdown"
import { authFetch, authUrl } from "@/lib/auth"
import { markdownComponents, parseLocalFileHref } from "../markdown-components"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true }),
  // Identity by default; real authUrl applies the device prefix + token.
  authUrl: vi.fn((url: string) => url),
}))

const mockedAuthUrl = vi.mocked(authUrl)

describe("markdown file links", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("parses encoded absolute paths and editor locations", () => {
    expect(parseLocalFileHref("/Users/me/My%20Project/src/app.ts:42:7")).toEqual({
      path: "/Users/me/My Project/src/app.ts",
      line: 42,
      column: 7,
    })
    expect(parseLocalFileHref("/Users/me/project/src/app.ts#L12C3")).toEqual({
      path: "/Users/me/project/src/app.ts",
      line: 12,
      column: 3,
    })
  })

  it("does not treat web URLs as local files", () => {
    expect(parseLocalFileHref("https://example.com/src/app.ts:42")).toBeNull()
  })

  it("opens an absolute markdown file link in the configured editor", () => {
    render(
      <ReactMarkdown components={markdownComponents}>
        {"[Open app.ts](/Users/me/My%20Project/src/app.ts:42:7)"}
      </ReactMarkdown>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Open app.ts" }))

    expect(authFetch).toHaveBeenCalledWith("/api/open-in-editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "/Users/me/My Project/src/app.ts",
        mode: "file",
        line: 42,
        column: 7,
      }),
    })
  })

  it("continues opening web links in the browser", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    render(
      <ReactMarkdown components={markdownComponents}>
        {"[Open docs](https://example.com/docs)"}
      </ReactMarkdown>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Open docs" }))

    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank")
    expect(authFetch).not.toHaveBeenCalled()
    open.mockRestore()
  })
})

describe("markdown images", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAuthUrl.mockImplementation((url: string) => url)
  })

  it("routes local image paths through authUrl (device prefix + token)", () => {
    render(
      <ReactMarkdown components={markdownComponents}>
        {"![shot](/tmp/screenshot.png)"}
      </ReactMarkdown>,
    )

    const img = screen.getByRole("img", { name: "shot" }) as HTMLImageElement
    // authUrl wraps the /api/local-file proxy URL.
    expect(mockedAuthUrl).toHaveBeenCalledWith(
      "/api/local-file?path=%2Ftmp%2Fscreenshot.png"
    )
    expect(img.getAttribute("src")).toBe(
      "/api/local-file?path=%2Ftmp%2Fscreenshot.png"
    )
  })

  it("does not route external/data image URLs through authUrl (no token leak)", () => {
    render(
      <ReactMarkdown components={markdownComponents}>
        {"![remote](https://cdn.example.com/pic.png)"}
      </ReactMarkdown>,
    )

    const img = screen.getByRole("img", { name: "remote" }) as HTMLImageElement
    expect(mockedAuthUrl).not.toHaveBeenCalled()
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/pic.png")
  })
})
