import { describe, expect, it } from "vitest"
import { occurrenceSpans, pickSpan, scopeSpans, spanElement, toRange } from "../sessionFindDom"

function el(html: string): HTMLElement {
  const holder = document.createElement("div")
  holder.innerHTML = html
  return holder.firstElementChild as HTMLElement
}

const text = (span: ReturnType<typeof occurrenceSpans>[number]) => toRange(span).toString()

describe("occurrenceSpans", () => {
  it("finds a match split across highlighted spans, with offsets in each text node", () => {
    const code = el(`<pre><span>const nee</span><span>dle = 1</span> // NEEDLE</pre>`)
    const spans = occurrenceSpans(code, "needle")
    expect(spans.map(text)).toEqual(["needle", "NEEDLE"])
    expect(spans[0].startContainer.nodeValue).toBe("const nee")
    expect(spans[0].startOffset).toBe(6)
    expect(spans[0].endContainer.nodeValue).toBe("dle = 1")
    expect(spans[0].endOffset).toBe(3)
  })

  it("ends a match at the node it closes, not at the start of the next one", () => {
    const row = el(`<div><b>needle</b><i>after</i></div>`)
    const [span] = occurrenceSpans(row, "needle")
    expect(span.endContainer.nodeValue).toBe("needle")
    expect(span.endOffset).toBe(6)
    expect(spanElement(span)).toBe(row.querySelector("b"))
  })

  it("leaves out subtrees that match `skip`, but never the scope itself", () => {
    const row = el(`<div data-tool-call-id="c0">needle <div data-tool-call-id="c1">needle</div> needle</div>`)
    expect(occurrenceSpans(row, "needle", "[data-tool-call-id]")).toHaveLength(2)
    expect(occurrenceSpans(row, "needle")).toHaveLength(3)
  })

  it("finds nothing for an empty query or an empty scope", () => {
    expect(occurrenceSpans(el(`<div>needle</div>`), "")).toEqual([])
    expect(occurrenceSpans(el(`<div></div>`), "needle")).toEqual([])
  })
})

describe("scopeSpans and pickSpan", () => {
  const row = el(`<div data-row-key="t"><p>needle a</p><div data-tool-call-id="c1"><b>needle</b><i>needle</i></div><p>needle b</p></div>`)

  it("counts a turn's text outside its tool cards, and a tool card's own text", () => {
    expect(scopeSpans(row, "needle", null, null)!.spans.map((span) => spanElement(span)!.textContent)).toEqual(["needle a", "needle b"])
    expect(scopeSpans(row, "needle", "c1", null)!.scope).toBe(row.querySelector("[data-tool-call-id]"))
    expect(scopeSpans(row, "needle", "missing", null)).toBeNull()
  })

  it("scopes a block's text to the innermost elements rendering it, leaving out nested blocks and tool cards", () => {
    const turn = el(`<div data-row-key="t">
      <p>needle head</p>
      <div data-blocks="3-5"><p>needle text</p>
        <div data-blocks="4-4"><i>needle thought one</i></div>
        <div data-tool-call-id="c9">needle call</div>
        <div data-blocks="4-4"><i>needle thought two</i></div>
      </div>
    </div>`)
    const words = (block: number | null) => scopeSpans(turn, "needle", null, block)!.spans.map((span) => spanElement(span)!.textContent)
    expect(words(3)).toEqual(["needle text"])
    expect(words(4)).toEqual(["needle thought one", "needle thought two"])
    expect(words(null)).toEqual(["needle head"])
    // A block a long turn has not mounted yet has no scope to count in.
    expect(scopeSpans(turn, "needle", null, 9)).toBeNull()
  })

  it("picks from the start or the end, and the nearest occurrence when the DOM shows fewer", () => {
    const spans = scopeSpans(row, "needle", "c1", null)!.spans
    expect(spanElement(pickSpan(spans, 0, false)!)!.tagName).toBe("B")
    expect(spanElement(pickSpan(spans, 0, true)!)!.tagName).toBe("I")
    expect(spanElement(pickSpan(spans, 5, false)!)!.tagName).toBe("I")
    expect(pickSpan([], 0, false)).toBeNull()
  })
})
