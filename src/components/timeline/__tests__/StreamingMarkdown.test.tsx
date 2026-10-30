import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ReactMarkdown from "react-markdown"
import { StreamingMarkdown, streamingMarkdownComponents, compactStreamingMarkdownComponents } from "../StreamingMarkdown"
import { markdownPlugins } from "../markdown-components"

const { highlight } = vi.hoisted(() => ({ highlight: vi.fn() }))
vi.mock("@/lib/shiki", () => ({ highlightCode: highlight }))

describe("StreamingMarkdown", () => {
  it.each([false, true])("matches the previous streaming renderer for every prefix and final GFM output (compact=%s)", async compact => {
    const sources = [
      "# Heading\n\n```ts\nconst x = 1\n```\n\nTail **bold**\n",
      "```\ncode\n```\n\n[ref] and [^foot]\n\n[ref]: https://example.test\n\n[^foot]: note\n",
      "- [x] task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![incomplete](/image.jpg)",
      "\uFEFFtext\r\n\r\n~~~\r\ncode\r\n~~~\r\n\r\nNext\r\n",
    ]
    const actual = render(<StreamingMarkdown text="" compactHeadings={compact} />)
    const baseline = render(<ReactMarkdown />)
    for (const source of sources) {
      for (let end = 0; end <= source.length; end++) {
        const prefix = source.slice(0, end)
        await act(async () => {
          actual.rerender(<StreamingMarkdown text={prefix} compactHeadings={compact} />)
          baseline.rerender(<ReactMarkdown components={compact ? compactStreamingMarkdownComponents : streamingMarkdownComponents} remarkPlugins={markdownPlugins}>{prefix}</ReactMarkdown>)
        })
        expect(actual.container.innerHTML, `prefix ${end}`).toBe(baseline.container.innerHTML)
      }
    }
    expect(actual.container.querySelector("img")).toBeNull()
    expect(highlight).not.toHaveBeenCalled()
  })
})
