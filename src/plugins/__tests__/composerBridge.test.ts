// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { addComposerKeyHandler, dispatchComposerKey, emitComposerEvent, onComposerEvent, registerComposer, type ComposerHandle, type ComposerKeyInput } from "../composerBridge"

const handle = (): ComposerHandle => ({ snapshot: vi.fn(), replace: vi.fn(() => null), focus: vi.fn() })
const key: ComposerKeyInput = { key: "ArrowUp", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, selectionStart: 0, selectionEnd: 0, suggestionsOpen: false }
const scope = { key: "k", cwd: "/p", identity: "i" }

describe("composer bridge", () => {
  it("delivers edits only from the active composer but always finishes a send", () => {
    const first = handle(), second = handle(), events: string[] = []
    const stopFirst = registerComposer(first)
    const stopSecond = registerComposer(second)
    const off = onComposerEvent((event) => events.push(event.type))
    emitComposerEvent(first, { type: "before-send", sendId: "s", scope, draft: { v: 1, text: "", context: [], attachments: [] } })
    emitComposerEvent(first, { type: "settled", sendId: "s", sent: true })
    emitComposerEvent(first, { type: "created", sendId: "s", session: { sessionId: "x", dirName: "d", cwd: "/p" } })
    emitComposerEvent(second, { type: "rejected-input", scope, text: "paste" })
    expect(events).toEqual(["settled", "created", "rejected-input"])
    off(); stopSecond(); stopFirst()
  })
  it("lets an extension consume a key only for the active composer, and isolates failures", () => {
    const composer = handle()
    const stop = registerComposer(composer)
    const failing = addComposerKeyHandler(() => { throw new Error("broken") })
    const handler = vi.fn(() => true)
    const remove = addComposerKeyHandler(handler)
    expect(dispatchComposerKey(handle(), key)).toBe(false)
    expect(dispatchComposerKey(composer, key)).toBe(true)
    remove(); failing()
    expect(dispatchComposerKey(composer, key)).toBe(false)
    stop()
  })
})
