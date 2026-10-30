import { describe, expect, it } from "vitest"
import {
  composerPromptText,
  CONTEXT_LIMITS,
  contextLabel,
  contextRefusal,
  isDraftEmpty,
  newContextId,
  parseComposerMessage,
  renderComposerMessage,
  renderContextItem,
  validateContext,
  type ComposerContextItem,
} from "../../../shared/session/composerContext"

const file: ComposerContextItem = { id: "ctx-file0001", kind: "file", path: "src/a \"b\".ts", startLine: 3, endLine: 9, text: "const a = 1\n</context>\n  </context> still text", comment: "Please simplify.\nKeep \"quotes\" & <tags>\r\nand lines" }
const terminal: ComposerContextItem = { id: "ctx-term0001", kind: "terminal", text: "$ bun test\n2 failed", label: "zsh · 2" }
const quote: ComposerContextItem = { id: "ctx-quote001", kind: "quote", text: "Use the existing queue.", source: { dirName: "-repo", fileName: "s.jsonl", sessionId: "s-1", turnId: "t-7" } }
const browser: ComposerContextItem = { id: "ctx-brow0001", kind: "browser", note: "This button overlaps the header", url: "https://example.test/a?b=1&c=2", title: "Settings", viewport: { width: 1280, height: 720 }, region: { x: 10, y: 20, width: 300, height: 80 }, capturedAt: "2026-10-29T12:00:00.000Z", browser: "default", tab: "Settings", image: 2 }

describe("composer envelope v1", () => {
  it("round-trips every kind of context through the one readable message", () => {
    const message = renderComposerMessage({ text: "  Fix these, please.  ", context: [file, terminal, quote, browser] })
    expect(message.endsWith("\n\nFix these, please.")).toBe(true)
    expect(message).toContain('kind="file" path="src/a &quot;b&quot;.ts" lines="3-9"')
    expect(parseComposerMessage(message)).toEqual({ context: [file, terminal, quote, browser], text: "Fix these, please." })
  })

  it("keeps a multiline review comment's line breaks", () => {
    const parsed = parseComposerMessage(renderComposerMessage({ text: "", context: [file] }))
    expect(parsed?.context[0]).toEqual(file)
    expect(parsed?.text).toBe("")
  })

  it("leaves a message without context, or one that only mentions a context tag, as it is", () => {
    expect(renderComposerMessage({ text: " hello ", context: [] })).toBe("hello")
    expect(parseComposerMessage("hello")).toBeNull()
    expect(parseComposerMessage("Look at this: <context id=\"ctx-file0001\" kind=\"file\" path=\"a\">\nx\n</context>")).toBeNull()
    expect(parseComposerMessage("<context id=\"bad\" kind=\"file\" path=\"a\">\nx\n</context>\n\nhi")).toBeNull()
    expect(parseComposerMessage("<context id=\"ctx-file0001\" kind=\"file\" path=\"a\">\nnever closed")).toBeNull()
  })

  it("reads what the author typed for titles and previews", () => {
    expect(composerPromptText(renderComposerMessage({ text: "Ship it", context: [terminal] }))).toBe("Ship it")
    expect(composerPromptText("plain")).toBe("plain")
  })

  it("bounds a draft's context and names each item for its chip", () => {
    expect(contextRefusal([], { ...terminal, text: "x".repeat(CONTEXT_LIMITS.itemChars + 1) })).toMatch(/longer than/)
    const full = Array.from({ length: CONTEXT_LIMITS.items }, (_, i) => ({ ...terminal, id: `ctx-full${String(i).padStart(4, "0")}` }))
    expect(contextRefusal(full, { ...terminal, id: "ctx-another1" })).toMatch(/at most/)
    expect(contextRefusal(full, full[0]!)).toBeNull()
    const heavy = Array.from({ length: 5 }, (_, i) => ({ ...terminal, id: `ctx-heavy${i}aa`, text: "x".repeat(CONTEXT_LIMITS.itemChars) }))
    expect(contextRefusal(heavy, { ...terminal, id: "ctx-last0001", text: "y" })).toMatch(/exceed/)
    expect([file, terminal, quote, browser].map(contextLabel)).toEqual(["a \"b\".ts:3-9", "Terminal · zsh · 2", "Quote · Use the existing queue.", "Browser · Settings"])
    expect(newContextId()).toMatch(/^ctx-[a-z0-9]{8,32}$/)
    expect(isDraftEmpty({ v: 1, text: " ", context: [], attachments: [] })).toBe(true)
    expect(isDraftEmpty({ v: 1, text: "", context: [terminal], attachments: [] })).toBe(false)
  })
})

describe("composer envelope bounds", () => {
  it("bounds metadata and the serialized size, at add, import and restore alike", () => {
    expect(contextRefusal([], { ...terminal, label: "x".repeat(200_000) })).toMatch(/label is longer than/)
    expect(contextRefusal([], { ...browser, url: `https://e.test/${"a".repeat(3_000)}` })).toMatch(/url is longer than/)
    expect(contextRefusal([], { ...quote, source: { ...quote.source, dirName: "d".repeat(3_000) } })).toMatch(/dir is longer than/)
    // Escaping counts: a title of quotes serializes six times longer than it reads.
    const quoted = Array.from({ length: 11 }, (_, i) => ({ ...browser, id: `ctx-quoted${String(i).padStart(4, "0")}`, title: '"'.repeat(1_900), note: "n".repeat(1_900) }))
    expect(validateContext(quoted)).toMatch(/exceed/)
    expect(validateContext([terminal, terminal])).toMatch(/twice/)
    expect(validateContext([file, terminal, quote, browser])).toBeNull()
  })

  it("leaves text past the bounds as plain text instead of importing it", () => {
    const oversized = renderContextItem({ ...terminal, label: "x".repeat(3_000) })
    expect(parseComposerMessage(`${oversized}\n\nhi`)).toBeNull()
    const many = Array.from({ length: CONTEXT_LIMITS.items + 1 }, (_, i) => renderContextItem({ ...terminal, id: `ctx-many${String(i).padStart(4, "0")}` })).join("\n\n")
    expect(parseComposerMessage(many)).toBeNull()
  })
})
