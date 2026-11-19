// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ASSET_HINTS, extractAssets } from "../../../shared/library/extract"

describe("extractAssets", () => {
  it("reads images, videos and documents shared with markdown syntax", () => {
    const text = [
      "Here is the run:",
      "![checkout page](/tmp/qa/checkout.png)",
      "![recording](/tmp/qa/run.webm)",
      "The full report is [in this file](/Users/me/reports/q3.pdf).",
    ].join("\n")
    expect(extractAssets(text)).toEqual([
      { kind: "image", target: "/tmp/qa/checkout.png", label: "checkout page" },
      { kind: "video", target: "/tmp/qa/run.webm", label: "recording" },
      { kind: "file", target: "/Users/me/reports/q3.pdf", label: "in this file" },
    ])
  })

  it("reads a bare media path alone on a line, as the timeline renders it", () => {
    expect(extractAssets("Done.\n\n  /tmp/shot.PNG  \n")).toEqual([{ kind: "image", target: "/tmp/shot.PNG", label: null }])
    expect(extractAssets("I saved it to /tmp/shot.png for you")).toEqual([])
  })

  it("reads web links: markdown links, autolinks and bare URLs", () => {
    const text = "Opened [PR #53](https://github.com/o/r/pull/53), see <https://example.com/docs> and https://a.dev/x?y=1."
    expect(extractAssets(text)).toEqual([
      { kind: "link", target: "https://github.com/o/r/pull/53", label: "PR #53" },
      { kind: "link", target: "https://example.com/docs", label: null },
      { kind: "link", target: "https://a.dev/x?y=1", label: null },
    ])
  })

  it("trims trailing punctuation and unbalanced parentheses from bare URLs", () => {
    expect(extractAssets("(see https://x.dev/a) and **https://y.dev/b**, also https://en.wikipedia.org/wiki/Foo_(bar)").map((asset) => asset.target))
      .toEqual(["https://x.dev/a", "https://y.dev/b", "https://en.wikipedia.org/wiki/Foo_(bar)"])
  })

  it("never reads inside fenced code blocks or inline code", () => {
    const text = [
      "Use `![x](/tmp/in-code.png)` or ``https://in-code.dev``.",
      "```md",
      "![example](/tmp/example.png)",
      "https://inside-fence.dev",
      "```",
      "~~~~",
      "[x](https://tilde.dev)",
      "~~~~",
      "After: https://after.dev",
    ].join("\n")
    expect(extractAssets(text)).toEqual([{ kind: "link", target: "https://after.dev", label: null }])
  })

  it("keeps reading after a fence whose closer is longer, and inside list items", () => {
    const text = ["- step", "  ```", "  https://hidden.dev", "  ````", "- [doc](/tmp/notes.md)"].join("\n")
    expect(extractAssets(text)).toEqual([{ kind: "file", target: "/tmp/notes.md", label: "doc" }])
  })

  it("reads stored views from cogpit-view fences, not inline views", () => {
    const text = ["```cogpit-view", "sales-dashboard@3", "```", "```cogpit-view", "<div>inline</div>", "```"].join("\n")
    expect(extractAssets(text)).toEqual([{ kind: "view", target: "sales-dashboard", label: null }])
  })

  it("leaves out code references, relative paths and unrelated schemes", () => {
    const text = [
      "[server/a.ts](/repo/server/a.ts:12)",
      "[b.md](/repo/b.md#L4)",
      "[main.ts](/repo/src/main.ts)",
      "[readme](docs/readme.md)",
      "[mail](mailto:a@b.c) [top](#top)",
    ].join("\n")
    expect(extractAssets(text)).toEqual([])
  })

  it("decodes file URLs, percent-encoding and Windows paths", () => {
    const text = [
      "![a](file:///tmp/my%20shot.png)",
      "![b](/C:/Users/me/b.jpg)",
      "[c](C:\\Users\\me\\c.pdf)",
      "[d](</tmp/with space/d.html>)",
    ].join("\n")
    expect(extractAssets(text).map((asset) => asset.target)).toEqual([
      "/tmp/my shot.png",
      "C:/Users/me/b.jpg",
      "C:\\Users\\me\\c.pdf",
      "/tmp/with space/d.html",
    ])
  })

  it("reads both halves of a linked image and skips a link title", () => {
    expect(extractAssets("[![preview](/tmp/p.png)](https://site.dev \"Site\")")).toEqual([
      { kind: "link", target: "https://site.dev", label: "preview" },
      { kind: "image", target: "/tmp/p.png", label: "preview" },
    ])
  })

  it("treats remote images as links, since the app cannot show them", () => {
    expect(extractAssets("![logo](https://cdn.dev/logo.png)")).toEqual([{ kind: "link", target: "https://cdn.dev/logo.png", label: "logo" }])
  })

  it("reads reference definitions", () => {
    expect(extractAssets("See [the docs][1].\n\n[1]: https://docs.dev/page \"Docs\"")).toEqual([
      { kind: "link", target: "https://docs.dev/page", label: "1" },
    ])
  })

  it("lists each asset once, keeping a label from any mention", () => {
    expect(extractAssets("https://a.dev/x then [A](https://a.dev/x) and https://a.dev/x")).toEqual([
      { kind: "link", target: "https://a.dev/x", label: "A" },
    ])
  })

  it("drops a label that only repeats the target and strips markup from the rest", () => {
    expect(extractAssets("[https://a.dev/](https://a.dev) [**Bold** `code`](https://b.dev)")).toEqual([
      { kind: "link", target: "https://a.dev", label: null },
      { kind: "link", target: "https://b.dev", label: "Bold code" },
    ])
  })

  it("keeps underscores in labels and drops one that only repeats the file name", () => {
    expect(extractAssets("[Q3_audit_final.docx](/tmp/a/Q3_audit_final.docx) [the _plan_](/tmp/plan.md)")).toEqual([
      { kind: "file", target: "/tmp/a/Q3_audit_final.docx", label: null },
      { kind: "file", target: "/tmp/plan.md", label: "the _plan_" },
    ])
  })

  it("leaves out dev servers on this computer", () => {
    expect(extractAssets("Open http://localhost:5173 or [app](http://127.0.0.1:3000/x) or http://[::1]:8080, not https://localhost.dev")).toEqual([
      { kind: "link", target: "https://localhost.dev", label: null },
    ])
  })

  it("ignores escaped brackets and unclosed syntax", () => {
    expect(extractAssets("\\[not](https://x.dev) [open](https://y.dev")).toEqual([
      { kind: "link", target: "https://x.dev", label: null },
      { kind: "link", target: "https://y.dev", label: null },
    ])
  })

  it("names every hint a sharing block must contain", () => {
    for (const text of ["![a](/tmp/a.png)", "https://x.dev", "/tmp/a.webm", "```cogpit-view\na@1\n```", "[1]: https://x.dev"]) {
      expect(ASSET_HINTS.some((hint) => text.includes(hint)), text).toBe(true)
    }
  })
})
