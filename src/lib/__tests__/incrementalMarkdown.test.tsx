// @vitest-environment node
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Plugin } from "unified"
import { IncrementalMarkdownParser, incrementalMarkdownPlugin, MARKDOWN_CACHE_LIMITS } from "../incrementalMarkdown"

function render(source: string, cache?: IncrementalMarkdownParser) {
  let tree: unknown
  const capture: Plugin = () => value => { tree = structuredClone(value) }
  const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, ...(cache ? [incrementalMarkdownPlugin(cache)] : []), capture]}>{source}</ReactMarkdown>)
  return { html, tree }
}

const samples = [
  "# Title\n\nA **bold** and ~~deleted~~ paragraph.\n\nNext line\n",
  "Before\n\n```ts\nconst x = [1, 2]\n// <literal>\n```\nAfter *closed* fence\n\nNext\n",
  "~~~python\na = 1\n~~~~\n\n```\nsecond\n```\n\nMore\n",
  "````md\n```nested\n[x]: url\n```\n````\n\nEnd\n",
  "```js\nlet open = true\n",
  "before\n\n[ref] and ![image][ref]\n\n[ref]: https://example.test \"title\"\n",
  "```txt\nsafe\n```\n\nA note[^one].\n\n[^one]: Footnote *with emphasis*\n\n    continued\n",
  "- first\n\n  second paragraph\n- [x] task\n  - nested\n\n1. numbered\n2. next\n",
  "Head | Value\n--- | :---:\na | b\n\nAfter\n",
  "Setext heading\n===\n\nsecond\n---\n",
  "<div>\ninside\n\n*markdown?*\n</div>\n\n<!-- comment\n\nend -->\n",
  "> quote\ncontinued lazily\n\n> next\n\n    indented code\n",
  "\uFEFF# BOM\r\n\r\n```ts\r\nconst x = 1\r\n```\r\n\r\nTail 😀\r\n",
  "a\rb\r\r```\rcode\r```\r",
  "Escaped \\[brackets\\] and `multi\nline`\n\nwww.example.test and a@b.test\n",
  "\uFEFF\n\nplain\n\n\uFEFFinterior BOM\n",
  "paragraph\n```\ncode\n```\nparagraph after\n",
  "```x`bad\nnot a real fence\n```\n\ntext\n",
  "   ~~~\ntext\n   ~~~  \n\ntext\n",
  "```\ncode\n```suffix\n\nstill code\n```\n",
]

describe("incremental Markdown equivalence", () => {
  it.each(samples.map((source, index) => ({ source, index })))("matches full GFM HTML and source positions at EVERY prefix, sample $index", ({ source }) => {
    const cache = new IncrementalMarkdownParser()
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end)
      expect(render(prefix, cache), `prefix ${end}: ${JSON.stringify(prefix)}`).toEqual(render(prefix))
    }
  })

  it("matches full parsing for deterministic mixed syntax streamed in irregular chunks", () => {
    const fragments = ["plain\n\n", "```\nx\n```\n", "~~~ x\ncode\n~~~\n", " \t \n", "**a**\n\n", "# h\n", "[ref]\n\n[ref]: /url\n", "label\n:---\nrow\n\n", "`x\n\n y`\n\n", "---\n", "[^f]\n\n[^f]: foot\n", "<div>\nhtml\n</div>\n"]
    let seed = 173
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
    for (let sample = 0; sample < 24; sample++) {
      const cache = new IncrementalMarkdownParser()
      const source = Array.from({ length: 6 }, () => fragments[random() % fragments.length]).join("")
      for (let end = 0; end < source.length; end += 1 + random() % 11) {
        expect(render(source.slice(0, end), cache)).toEqual(render(source.slice(0, end)))
      }
      expect(render(source, cache)).toEqual(render(source))
    }
  })

  it("preserves replacement, truncation and reset after cached fences or unsafe syntax", () => {
    const cache = new IncrementalMarkdownParser()
    for (const source of ["```\na\n```\n\nold", "```\nb\n```\n\nnew", "short", "", "\uFEFFplain\n\n", "[r]\n\n[r]: /x", "```\nreset\n```\n\nmore"]) {
      expect(render(source, cache)).toEqual(render(source))
    }
  })

  it("falls back for references, footnotes, lists, tables, setext and HTML after a cached prefix", () => {
    for (const unsafe of ["[ref]", "[^note]", "- item", "1. item", "head\n---", "a | b", "<div>", "> quote", "    code"]) {
      const cache = new IncrementalMarkdownParser()
      const prefix = "```\nstable\n```\n\n"
      render(prefix, cache)
      expect(cache.stats().cachedCharacters).toBe(prefix.length)
      expect(render(prefix + unsafe, cache)).toEqual(render(prefix + unsafe))
      expect(cache.stats().cachedCharacters).toBe(0)
      expect(cache.stats().fullParses).toBe(1)
    }
  })

  it("parses only the appended tail after a closed large fence and measures reduced parser input", () => {
    const cache = new IncrementalMarkdownParser()
    const prefix = "```ts\n" + "const x = 1\n".repeat(1000) + "```\n\n"
    let fullCharacters = 0
    for (let i = 0; i <= 40; i++) {
      const source = prefix + "tail ".repeat(i)
      fullCharacters += source.length
      expect(render(source, cache).html).toBe(render(source).html)
    }
    expect(cache.stats().parseCalls).toBe(41)
    expect(cache.stats().parsedCharacters).toBeLessThan(fullCharacters / 10)
    expect(cache.stats().scannedCharacters).toBeLessThan(fullCharacters / 10)
  })

  it("bounds retained prefix characters and node count without dropping output", () => {
    const cache = new IncrementalMarkdownParser()
    const large = "```\n" + "x".repeat(1_000_001) + "\n```\n"
    expect(render(large, cache).html).toBe(render(large).html)
    expect(cache.stats().cachedCharacters).toBe(0)
    const many = "paragraph\n\n".repeat(257)
    expect(render(many, cache).html).toBe(render(many).html)
    expect(cache.stats().cachedCharacters).toBe(0)
  })

  it("bounds total nested nodes independently of top-level entries", () => {
    const cache = new IncrementalMarkdownParser()
    const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 5, offset: 4 } }
    const tree = { type: "root", position, children: [{ type: "paragraph", position, children: Array.from({ length: MARKDOWN_CACHE_LIMITS.nodes }, () => ({ type: "text", value: "x" })) }] }
    expect(cache.parse("text\n\n", () => tree)).toBe(tree)
    expect(cache.stats().cachedCharacters).toBe(0)
  })

  it("bounds estimated retained bytes independently of characters and entry count", () => {
    const cache = new IncrementalMarkdownParser()
    const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 5, offset: 4 } }
    const tree = { type: "root", position, children: [{ type: "code", position, value: "x".repeat(MARKDOWN_CACHE_LIMITS.bytes / 2) }] }
    expect(cache.parse("text\n\n", () => tree)).toBe(tree)
    expect(cache.stats().cachedCharacters).toBe(0)
    expect(cache.stats().cacheBytes).toBe(0)
  })
})
