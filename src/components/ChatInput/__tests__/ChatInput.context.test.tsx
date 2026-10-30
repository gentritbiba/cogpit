import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  source: null as { dirName: string; fileName: string; rawText: string } | null,
  session: { sessionId: "session-1" } as { sessionId: string } | null,
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.source,
    isLive: false,
    actions: { handleEditConfig: vi.fn(), handleOpenQuoteSource: vi.fn(async () => true) },
    pendingInteraction: null,
    permissionRequests: [],
    permissionResponding: new Set(),
    respondPermission: vi.fn(),
    respondAllPermissions: vi.fn(),
    slashSuggestions: [],
    slashSuggestionsLoading: false,
    turnError: null,
    promptSuggestion: null,
  }),
  useSessionChatContext: () => ({
    chat: { status: "idle", error: null, isConnected: false, sendMessage: mocks.sendMessage, interrupt: vi.fn() },
  }),
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/hooks/useProjectFileSuggestions", () => ({ useProjectFileSuggestions: () => ({ files: [], loading: false }) }))
vi.mock("@/components/SlashSuggestions", () => ({ SlashSuggestions: () => null }))
vi.mock("@/components/FileSuggestions", () => ({ FileSuggestions: () => null }))
vi.mock("@/plugins/RuntimePluginActions", () => ({ RuntimePluginActions: () => null, useComposerPlugins: () => null }))

import { ChatInput, type ChatInputHandle } from "../index"
import { resetDraftStoresForTest } from "../draftStore"
import { renderComposerMessage, type ComposerContextItem } from "../../../../shared/session/composerContext"

const excerpt: ComposerContextItem = { id: "ctx-excerpt01", kind: "file", path: "src/app.ts", startLine: 4, endLine: 6, text: "const x = 1", comment: "Why?" }
const capture: ComposerContextItem = { id: "ctx-capture01", kind: "browser", note: "Overlap", url: "https://example.test", title: "Home", viewport: { width: 800, height: 600 }, region: { x: 0, y: 0, width: 100, height: 50 }, capturedAt: "2026-10-29T12:00:00.000Z", browser: "default", image: 1 }

function mount(props: Parameters<typeof ChatInput>[0] = {}) {
  const ref = createRef<ChatInputHandle>()
  const view = render(<ChatInput ref={ref} {...props} />)
  return { ref, ...view }
}

beforeEach(() => {
  localStorage.clear(); resetDraftStoresForTest(); mocks.source = null
  mocks.sendMessage.mockReset().mockResolvedValue(true)
  mocks.session = { sessionId: crypto.randomUUID() }
})

describe("ChatInput context", () => {
  it("shows added context as chips and sends the readable message with the capture's image", async () => {
    const { ref } = mount()
    act(() => {
      expect(ref.current!.addContext(excerpt)).toBeNull()
      expect(ref.current!.addContext(capture, [{ id: "img-1", mediaType: "image/jpeg", data: "aGk=" }])).toBeNull()
      expect(ref.current!.addContext(excerpt)).toBeNull()
    })
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByRole("button", { name: /File excerpt: app\.ts:4-6/ })).toBeInTheDocument()
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Fix both" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
    expect(mocks.sendMessage).toHaveBeenCalledWith(renderComposerMessage({ text: "Fix both", context: [excerpt, capture] }), [{ data: "aGk=", mediaType: "image/jpeg" }])
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(ref.current!.getDraft()).toEqual({ v: 1, text: "", context: [], attachments: [] })
  })

  it("sends context without typed text, and removes a chip from the keyboard with the image it brought", async () => {
    const { ref } = mount()
    act(() => { ref.current!.addContext(capture, [{ id: "img-1", mediaType: "image/jpeg", data: "aGk=" }]) })
    expect(ref.current!.getDraft().attachments).toEqual([{ id: "img-1", mediaType: "image/jpeg", data: "aGk=", contextId: "ctx-capture01" }])
    fireEvent.keyDown(screen.getByRole("button", { name: /Browser annotation: Browser · Home/ }), { key: "Delete" })
    expect(ref.current!.getDraft()).toMatchObject({ context: [], attachments: [] })
    act(() => { ref.current!.addContext(excerpt) })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
    expect(mocks.sendMessage).toHaveBeenCalledWith(renderComposerMessage({ text: "", context: [excerpt] }), undefined)
  })

  it("puts a refused message's context back, and keeps a draft across setDraft/getDraft", async () => {
    mocks.sendMessage.mockResolvedValue(false)
    const { ref } = mount()
    act(() => { ref.current!.addContext(excerpt) })
    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "Please" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
    expect(ref.current!.getDraft()).toMatchObject({ text: "Please", context: [excerpt] })
    const draft = { v: 1 as const, text: "Restored", context: [capture], attachments: [{ id: "img-9", mediaType: "image/png", data: "eA==", contextId: capture.id }] }
    act(() => ref.current!.setDraft(draft))
    expect(ref.current!.getDraft()).toEqual(draft)
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Restored")
  })

  it("refuses context past its bounds, and an image capture where the model takes no images", () => {
    const { ref, rerender } = mount()
    let refusal: string | null = null
    act(() => { refusal = ref.current!.addContext({ id: "ctx-huge0001", kind: "terminal", text: "x".repeat(20_001) }) })
    expect(refusal).toMatch(/longer than/)
    expect(screen.getByRole("alert")).toHaveTextContent(/longer than/)
    rerender(<ChatInput ref={ref} allowImages={false} />)
    act(() => { refusal = ref.current!.addContext(capture, [{ id: "img-1", mediaType: "image/jpeg", data: "aGk=" }]) })
    expect(refusal).toMatch(/does not accept images/)
    expect(ref.current!.getDraft().context).toEqual([])
  })

  it("pastes a copied message with context back as the same chips", () => {
    const { ref } = mount()
    const message = screen.getByRole("combobox", { name: "Message" })
    fireEvent.paste(message, { clipboardData: { getData: () => renderComposerMessage({ text: "again", context: [excerpt] }), items: [] } })
    expect(ref.current!.getDraft()).toMatchObject({ text: "again", context: [excerpt] })
  })
})


describe("ChatInput durable stash and recall", () => {
  const message = () => screen.getByRole("combobox", { name: "Message" })
  const type = (text: string) => fireEvent.change(message(), { target: { value: text } })
  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save prompt stash" }))
  const list = () => fireEvent.click(screen.getByRole("button", { name: /Saved prompts/ }))

  it("saves and restores text, context and image bytes after unmount and fresh storage load", () => {
    const view = mount({ projectCwd: "/repo" })
    act(() => { view.ref.current!.addContext(capture, [{ id: "capture-a", mediaType: "image/png", data: "eA==" }]) })
    type("Please inspect")
    save()
    expect(message()).toHaveValue("")
    view.unmount(); resetDraftStoresForTest()
    const next = mount({ projectCwd: "/repo" })
    list()
    fireEvent.click(screen.getByRole("button", { name: "Restore Please inspect" }))
    expect(next.ref.current!.getDraft()).toMatchObject({ text: "Please inspect", context: [capture], attachments: [{ id: "capture-a", contextId: capture.id, data: "eA==" }] })
  })

  it("keeps current text on quota failure, then retries without a duplicate stash", () => {
    mount(); type("do not erase")
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError") })
    save()
    expect(message()).toHaveValue("do not erase")
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/)
    write.mockRestore()
    save()
    expect(message()).toHaveValue("")
    list()
    expect(screen.getAllByRole("button", { name: "Restore do not erase" })).toHaveLength(1)
  })

  it.each(["swap", "merge"])("requires explicit %s when restoring into a nonempty draft", (mode) => {
    mount(); type("saved"); save(); type("current"); list()
    fireEvent.click(screen.getByRole("button", { name: "Restore saved" }))
    expect(message()).toHaveValue("current")
    fireEvent.click(screen.getByRole("button", { name: mode === "swap" ? "Swap drafts" : "Merge drafts" }))
    expect(message()).toHaveValue(mode === "swap" ? "saved" : "current\n\nsaved")
    if (mode === "swap") expect(screen.getByRole("button", { name: "Restore current" })).toBeInTheDocument()
  })

  it.each(["text", "context", "capture", "switch"])("retains a complete refused capture separately from newer %s", async (newer) => {
    let refuse!: (sent: boolean) => void
    mocks.sendMessage.mockReturnValueOnce(new Promise<boolean>((resolve) => { refuse = resolve }))
    const view = mount({ projectCwd: "/repo" })
    const firstSession = mocks.session
    act(() => { view.ref.current!.addContext(capture, [{ id: "capture-a", mediaType: "image/png", data: "eA==" }]) })
    type("first capture")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
    if (newer === "text" || newer === "switch") type("newer typing")
    if (newer === "context") act(() => { view.ref.current!.addContext(excerpt) })
    if (newer === "capture") act(() => { view.ref.current!.addContext({ ...capture, id: "ctx-capture02" }, [{ id: "capture-b", mediaType: "image/png", data: "eQ==" }]) })
    const current = view.ref.current!.getDraft()
    if (newer === "switch") { mocks.session = { sessionId: "elsewhere" }; view.rerender(<ChatInput ref={view.ref} projectCwd="/repo" allowImages={false} />) }
    await act(async () => { refuse(false) })
    if (newer === "switch") {
      expect(view.ref.current!.getDraft().text).toBe("")
      mocks.session = firstSession; view.rerender(<ChatInput ref={view.ref} projectCwd="/repo" />)
    }
    expect(view.ref.current!.getDraft()).toEqual(current)
    list()
    fireEvent.click(screen.getByRole("button", { name: "Restore first capture" }))
    fireEvent.click(screen.getByRole("button", { name: "Swap drafts" }))
    expect(view.ref.current!.getDraft()).toMatchObject({ text: "first capture", context: [capture], attachments: [{ id: "capture-a", contextId: capture.id }] })
  })

  it("shows unsupported model error on restoring bytes and prevents sending them", async () => {
    const view = mount()
    act(() => view.ref.current!.setDraft({ v: 1, text: "image prompt", context: [capture], attachments: [{ id: "a", contextId: capture.id, mediaType: "image/png", data: "eA==" }] }))
    save()
    view.rerender(<ChatInput ref={view.ref} allowImages={false} />)
    list(); fireEvent.click(screen.getByRole("button", { name: "Restore image prompt" }))
    expect(screen.getByRole("status")).toHaveTextContent(/does not accept images/)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(view.ref.current!.getDraft().attachments).toHaveLength(1)
  })

  it("recalls confirmed sends in order, stops on edit, and retains recalled drafts through reload", async () => {
    const view = mount()
    for (const text of ["first", "second"]) { type(text); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) }) }
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("second")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("first")
    fireEvent.keyDown(message(), { key: "ArrowDown" }); expect(message()).toHaveValue("second")
    fireEvent.keyDown(message(), { key: "ArrowDown" }); expect(message()).toHaveValue("")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); type("edited second")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("edited second")
    view.unmount(); resetDraftStoresForTest(); mount()
    expect(message()).toHaveValue("edited second")
  })

  it("leaves IME, selection and slash/file suggestion keys to editing, and supports the stash shortcut", async () => {
    mount(); type("sent"); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    fireEvent.keyDown(message(), { key: "ArrowUp", isComposing: true }); expect(message()).toHaveValue("")
    type("/skill"); fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("/skill")
    type("draft"); fireEvent.keyDown(message(), { key: "s", ctrlKey: true, shiftKey: true }); expect(message()).toHaveValue("")
    list(); expect(screen.getByRole("button", { name: "Restore draft" })).toBeInTheDocument()
  })

  it("marks a crashed send unconfirmed across reload and exposes a durable delete control", async () => {
    mocks.sendMessage.mockReturnValueOnce(new Promise(() => {}))
    const view = mount(); type("unknown receipt"); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    view.unmount(); resetDraftStoresForTest(); mount(); list()
    expect(screen.getByText(/Unconfirmed send/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Delete unknown receipt" }))
    expect(screen.queryByRole("button", { name: "Restore unknown receipt" })).not.toBeInTheDocument()
  })
})


it("hands the exact accepted first prompt to its created session without moving newer pending/target drafts", async () => {
  mocks.session = null
  let created!: (identity: { sessionId: string; cwd: string; dirName: string }) => void
  let accepted!: (sent: boolean) => void
  mocks.sendMessage.mockImplementationOnce((_text, _images, callback) => { created = callback; return new Promise<boolean>((resolve) => { accepted = resolve }) })
  const view = mount({ projectCwd: "/pending", composerIdentity: "pending-project" })
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "exact first prompt" } })
  await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }) })
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "new pending typing" } })
  act(() => { created({ sessionId: "created-a", cwd: "/actual-worktree", dirName: "actual-project" }) })
  mocks.session = { sessionId: "created-a" }; mocks.source = { dirName: "actual-project", fileName: "created-a.jsonl", rawText: "" }
  view.rerender(<ChatInput ref={view.ref} projectCwd="/actual-worktree" />)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "new target typing" } })
  await act(async () => { accepted(true) })
  expect(screen.getByRole("combobox")).toHaveValue("new target typing")
  fireEvent.click(screen.getByRole("button", { name: "Save prompt stash" }))
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" })
  expect(screen.getByRole("combobox")).toHaveValue("exact first prompt")
  mocks.session = null; mocks.source = null
  view.rerender(<ChatInput ref={view.ref} projectCwd="/pending" composerIdentity="pending-project" />)
  expect(screen.getByRole("combobox")).toHaveValue("new pending typing")
})

it("retains oversized restored context for correction and blocks its send", async () => {
  const view = mount()
  const invalid = { v: 1 as const, text: "keep this original", context: [{ id: "ctx-metadata1", kind: "terminal" as const, text: "snapshot", label: "x".repeat(200_000) }], attachments: [] }
  act(() => view.ref.current!.setDraft(invalid))
  await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }) })
  expect(mocks.sendMessage).not.toHaveBeenCalled()
  expect(view.ref.current!.getDraft()).toEqual(invalid)
  expect(screen.getAllByRole("alert").some((alert) => /longer|could not be saved/.test(alert.textContent!))).toBe(true)
})

it.each(["count", "serialized size"])("preflights pasted context atomically near the %s bound and keeps the complete rejected import", (bound) => {
  const view = mount()
  const existing = bound === "count"
    ? Array.from({ length: 11 }, (_, i) => ({ id: `ctx-existing${String(i).padStart(2, "0")}`, kind: "terminal" as const, text: `existing ${i}` }))
    : Array.from({ length: 4 }, (_, i) => ({ id: `ctx-existing${String(i).padStart(2, "0")}`, kind: "terminal" as const, text: "x".repeat(20_000) }))
  act(() => view.ref.current!.setDraft({ v: 1, text: "current typing", context: existing, attachments: [] }))
  const context = [0, 1].map((i) => ({ id: `ctx-imported0${i}`, kind: "terminal" as const, text: bound === "count" ? `new ${i}` : "y".repeat(15_000) }))
  const pasted = renderComposerMessage({ text: "complete clipboard text", context })
  fireEvent.paste(screen.getByRole("combobox"), { clipboardData: { getData: () => pasted, items: [] } })
  expect(view.ref.current!.getDraft()).toEqual({ v: 1, text: "current typing", context: existing, attachments: [] })
  expect(screen.getByRole("alert")).toHaveTextContent(/complete pasted message is kept/)
  fireEvent.click(screen.getByRole("button", { name: /Saved prompts/ }))
  expect(screen.getByRole("region", { name: "Saved prompts" })).toHaveTextContent(/Stashed prompt/)
  const records = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key.includes("composer-v1")).map((key) => JSON.parse(localStorage.getItem(key)!))
  expect(records.some((record) => record.entries.some((entry: { draft: { text: string } }) => entry.draft.text === pasted))).toBe(true)
})
