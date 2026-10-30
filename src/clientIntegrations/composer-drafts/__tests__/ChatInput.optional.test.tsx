import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

import { ChatInput, type ChatInputHandle } from "@/components/ChatInput"
import { composerScope, draftStore, resetDraftStoresForTest } from "../draftStore"
import { activate } from "../index"
import { activeComposer } from "@/plugins/composerBridge"
import { resetUnsentRecoveriesForTest } from "@/components/ChatInput/unsentRecovery"
import { setActiveIdentity } from "@/lib/device"
import { renderComposerMessage, type ComposerContextItem } from "../../../../shared/session/composerContext"

const excerpt: ComposerContextItem = { id: "ctx-excerpt01", kind: "file", path: "src/app.ts", startLine: 4, endLine: 6, text: "const x = 1", comment: "Why?" }
const capture: ComposerContextItem = { id: "ctx-capture01", kind: "browser", note: "Overlap", url: "https://example.test", title: "Home", viewport: { width: 800, height: 600 }, region: { x: 0, y: 0, width: 100, height: 50 }, capturedAt: "2026-10-29T12:00:00.000Z", browser: "default", image: 1 }

let integration: ReturnType<typeof activate>
let activation: AbortController
const message = () => screen.getByRole("combobox", { name: "Message" })
const type = (text: string) => fireEvent.change(message(), { target: { value: text } })
const token = () => activeComposer()!.snapshot().token
const signal = () => new AbortController().signal
const list = () => integration.request("drafts.list", {}, signal())
async function save() { await act(async () => { await integration.request("drafts.capture", { token: token(), clear: true }, signal()) }) }
async function restore(id: string, mode: "replace" | "swap" | "merge" = "replace") {
  await act(async () => { await integration.request("drafts.restore", { token: token(), id, mode }, signal()) })
}
function mount(props: Parameters<typeof ChatInput>[0] = {}) {
  const ref = createRef<ChatInputHandle>()
  const view = render(<ChatInput ref={ref} {...props} />)
  activation = new AbortController()
  act(() => { integration = activate({ pluginId: "cogpit.saved-drafts", signal: activation.signal, inScope: () => true }) })
  return { ref, ...view }
}
beforeEach(() => {
  localStorage.clear(); resetDraftStoresForTest(); resetUnsentRecoveriesForTest(); setActiveIdentity(null); mocks.source = null
  mocks.sendMessage.mockReset().mockResolvedValue(true)
  mocks.session = { sessionId: crypto.randomUUID() }
})
afterEach(() => { activation?.abort(); integration?.dispose(); vi.restoreAllMocks() })

describe("optional Saved drafts composer integration", () => {
  it("saves and restores text, context and image bytes after unmount and a fresh storage load", async () => {
    const view = mount({ projectCwd: "/repo" })
    act(() => { view.ref.current!.addContext(capture, [{ id: "capture-a", mediaType: "image/png", data: "eA==" }]) })
    type("Please inspect"); await save()
    expect(message()).toHaveValue("")
    activation.abort(); view.unmount(); resetDraftStoresForTest(); resetUnsentRecoveriesForTest()
    const next = mount({ projectCwd: "/repo" })
    const entries = await list()
    expect(entries.items[0]).toMatchObject({ text: "Please inspect", images: [{ mediaType: "image/png", bytes: 1 }] })
    expect(JSON.stringify(entries)).not.toContain("eA==")
    await restore(entries.items[0]!.id)
    expect(next.ref.current!.getDraft()).toMatchObject({ text: "Please inspect", context: [capture], attachments: [{ id: "capture-a", contextId: capture.id, data: "eA==" }] })
  })

  it("keeps current text on quota failure, then retries without a duplicate saved draft", async () => {
    mount(); type("do not erase")
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError") })
    await expect(save()).rejects.toThrow(/could not be saved/)
    expect(message()).toHaveValue("do not erase")
    expect((await list()).error).toMatch(/could not be saved/)
    expect((await list()).items).toHaveLength(0)
    write.mockRestore(); await save()
    expect(message()).toHaveValue("")
    expect((await list()).items.filter((entry) => entry.text === "do not erase")).toHaveLength(1)
  })

  it.each(["swap", "merge"] as const)("requires explicit %s into a nonempty draft", async (mode) => {
    mount(); type("saved"); await save(); type("current")
    const id = (await list()).items[0]!.id
    await expect(restore(id)).rejects.toThrow(/current draft has content/)
    expect(message()).toHaveValue("current")
    await restore(id, mode)
    expect(message()).toHaveValue(mode === "swap" ? "saved" : "current\n\nsaved")
    if (mode === "swap") expect((await list()).items.some((entry) => entry.text === "current")).toBe(true)
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
    const entry = (await list()).items.find((entry) => entry.kind === "refused")!
    await restore(entry.id, "swap")
    expect(view.ref.current!.getDraft()).toMatchObject({ text: "first capture", context: [capture], attachments: [{ id: "capture-a", contextId: capture.id }] })
  })

  it("restores bytes under an unsupported model and blocks sending them", async () => {
    const view = mount()
    act(() => view.ref.current!.setDraft({ v: 1, text: "image draft", context: [capture], attachments: [{ id: "a", contextId: capture.id, mediaType: "image/png", data: "eA==" }] }))
    await save()
    view.rerender(<ChatInput ref={view.ref} allowImages={false} />)
    await restore((await list()).items[0]!.id)
    expect(screen.getByRole("status")).toHaveTextContent(/does not accept images/)
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(view.ref.current!.getDraft().attachments).toHaveLength(1)
  })

  it("recalls accepted sends in order, stops on edit, and retains the recalled draft on reload", async () => {
    const view = mount()
    for (const text of ["first", "second"]) { type(text); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) }) }
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("second")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("first")
    fireEvent.keyDown(message(), { key: "ArrowDown" }); expect(message()).toHaveValue("second")
    fireEvent.keyDown(message(), { key: "ArrowDown" }); expect(message()).toHaveValue("")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); type("edited second")
    fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("edited second")
    activation.abort(); view.unmount(); resetDraftStoresForTest(); resetUnsentRecoveriesForTest(); mount()
    expect(message()).toHaveValue("edited second")
  })

  it("leaves IME, selection and suggestion keys to editing, and supports the save shortcut", async () => {
    mount(); type("sent"); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    fireEvent.keyDown(message(), { key: "ArrowUp", isComposing: true }); expect(message()).toHaveValue("")
    type("/skill"); fireEvent.keyDown(message(), { key: "ArrowUp" }); expect(message()).toHaveValue("/skill")
    type("draft"); fireEvent.keyDown(message(), { key: "s", ctrlKey: true, shiftKey: true }); expect(message()).toHaveValue("")
    expect((await list()).items.some((entry) => entry.text === "draft" && entry.kind === "stash")).toBe(true)
  })

  it("keeps crashed sends unconfirmed across reload and deletes durably", async () => {
    mocks.sendMessage.mockReturnValueOnce(new Promise(() => {}))
    const view = mount(); type("unknown receipt"); await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    activation.abort(); view.unmount(); resetDraftStoresForTest(); resetUnsentRecoveriesForTest(); mount()
    const entry = (await list()).items[0]!
    expect(entry).toMatchObject({ kind: "sending", text: "unknown receipt" })
    await integration.request("drafts.remove", { token: token(), id: entry.id }, signal())
    expect((await list()).items).toHaveLength(0)
  })

  it.each(["before", "after"])("hands the exact accepted first prompt to the created session with callback %s settlement", async (ordering) => {
    mocks.session = null
    let created!: (identity: { sessionId: string; cwd: string; dirName: string }) => void
    let accepted!: (sent: boolean) => void
    mocks.sendMessage.mockImplementationOnce((_text, _images, callback) => { created = callback; return new Promise<boolean>((resolve) => { accepted = resolve }) })
    const view = mount({ projectCwd: "/pending", composerIdentity: "pending-project" })
    type("exact first prompt")
    await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    type("new pending typing")
    const identity = { sessionId: "created-a", cwd: "/actual-worktree", dirName: "actual-project" }
    if (ordering === "before") act(() => { created(identity) })
    mocks.session = { sessionId: "created-a" }; mocks.source = { dirName: "actual-project", fileName: "created-a.jsonl", rawText: "" }
    view.rerender(<ChatInput ref={view.ref} projectCwd="/actual-worktree" />)
    type("new target typing")
    await act(async () => { accepted(true) })
    if (ordering === "after") act(() => { created(identity) })
    expect(message()).toHaveValue("new target typing")
    await save(); fireEvent.keyDown(message(), { key: "ArrowUp" })
    expect(message()).toHaveValue("exact first prompt")
    mocks.session = null; mocks.source = null
    view.rerender(<ChatInput ref={view.ref} projectCwd="/pending" composerIdentity="pending-project" />)
    expect(message()).toHaveValue("new pending typing")
  })

  it.each(["count", "serialized size"])("preflights pasted context atomically near the %s bound and retains the complete rejected import", async (bound) => {
    const view = mount()
    const existing = bound === "count"
      ? Array.from({ length: 11 }, (_, i) => ({ id: `ctx-existing${String(i).padStart(2, "0")}`, kind: "terminal" as const, text: `existing ${i}` }))
      : Array.from({ length: 4 }, (_, i) => ({ id: `ctx-existing${String(i).padStart(2, "0")}`, kind: "terminal" as const, text: "x".repeat(20_000) }))
    act(() => view.ref.current!.setDraft({ v: 1, text: "current typing", context: existing, attachments: [] }))
    const imported = [0, 1].map((i) => ({ id: `ctx-imported0${i}`, kind: "terminal" as const, text: bound === "count" ? `new ${i}` : "y".repeat(15_000) }))
    const pasted = renderComposerMessage({ text: "complete clipboard text", context: imported })
    fireEvent.paste(message(), { clipboardData: { getData: () => pasted, items: [] } })
    expect(view.ref.current!.getDraft()).toEqual({ v: 1, text: "current typing", context: existing, attachments: [] })
    expect(screen.getByRole("alert")).toHaveTextContent(/complete pasted message is kept/)
    const store = draftStore(activeComposer()!.snapshot().scope.key)
    expect(store.getSnapshot().record.entries.some((entry) => entry.draft.text === pasted)).toBe(true)
  })

  it("disables hooks without deleting legacy bytes and restores them only on explicit reactivation", async () => {
    mount(); type("legacy image")
    await save()
    const key = activeComposer()!.snapshot().scope.key
    const raw = localStorage.getItem(key)
    activation.abort()
    type("untracked typing"); fireEvent.keyDown(message(), { key: "s", ctrlKey: true, shiftKey: true })
    expect(message()).toHaveValue("untracked typing")
    expect(localStorage.getItem(key)).toBe(raw)
    await expect(list()).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    activation = new AbortController()
    act(() => { integration = activate({ pluginId: "cogpit.saved-drafts", signal: activation.signal, inScope: () => true }) })
    expect((await list()).items[0]!.text).toBe("legacy image")
    expect(message()).toHaveValue("untracked typing")
  })

  it("rejects stale tokens, busy sends, account switches and canceled requests without modifying bytes", async () => {
    const view = mount({ projectCwd: "/repo" }); type("saved"); await save()
    const stale = token(); const id = (await list()).items[0]!.id
    type("new typing")
    const raw = localStorage.getItem(activeComposer()!.snapshot().scope.key)
    await expect(integration.request("drafts.restore", { token: stale, id, mode: "swap" }, signal())).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(localStorage.getItem(activeComposer()!.snapshot().scope.key)).toBe(raw)
    const abort = new AbortController(); abort.abort()
    await expect(integration.request("drafts.remove", { token: token(), id }, abort.signal)).rejects.toThrow()
    mocks.sendMessage.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => { fireEvent.keyDown(message(), { key: "Enter" }) })
    await expect(integration.request("drafts.capture", { token: token(), clear: true }, signal())).rejects.toMatchObject({ code: "CONFLICT" })
    act(() => { setActiveIdentity("other-account") })
    view.rerender(<ChatInput ref={view.ref} projectCwd="/other-repo" />)
    await expect(list()).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(view.ref.current!.getDraft().text).toBe("")
  })

  it("requires a current host-side raw backup before resetting damaged storage", async () => {
    const identity = JSON.stringify(["", mocks.session!.sessionId])
    const key = composerScope("/repo", identity)
    localStorage.setItem(key, "{broken legacy bytes")
    mount({ projectCwd: "/repo" }); type("new typing")
    expect((await list()).corrupt).toBe(true)
    await expect(integration.request("drafts.recover", { token: token(), action: "reset" }, signal())).rejects.toThrow(/backup/)
    const create = vi.fn(() => "blob:backup"); Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    await integration.request("drafts.backup", { token: token() }, signal())
    expect(create).toHaveBeenCalledWith(expect.any(Blob))
    expect(draftStore(key).backup()).toContain("{broken legacy bytes")
    await act(async () => { await integration.request("drafts.recover", { token: token(), action: "reset" }, signal()) })
    expect((await list()).corrupt).toBe(false)
    expect(JSON.parse(localStorage.getItem(key)!).draft.text).toBe("new typing")
  })
})

it("never reads legacy bytes or installs keyboard behavior outside the enabled project", async () => {
  const ref = createRef<ChatInputHandle>()
  render(<ChatInput ref={ref} projectCwd="/outside" />)
  const read = vi.spyOn(localStorage, "getItem")
  activation = new AbortController()
  integration = activate({ pluginId: "cogpit.saved-drafts", signal: activation.signal, inScope: (cwd) => cwd === "/allowed" })
  type("outside typing")
  fireEvent.keyDown(message(), { key: "s", ctrlKey: true, shiftKey: true })
  expect(message()).toHaveValue("outside typing")
  await expect(list()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
  expect(read.mock.calls.filter(([key]) => key.includes("composer-v1"))).toHaveLength(0)
})

it("bounds metadata pages below the frame limit even with Unicode and large image bytes", async () => {
  mount()
  const store = draftStore(activeComposer()!.snapshot().scope.key)
  for (let i = 0; i < 23; i++) store.copy({ v: 1, text: `${i} ${"𐍈".repeat(3000)}`, context: [], attachments: [{ id: `image-${i}`, mediaType: "image/png", data: "a".repeat(80_000) }] })
  const first = await list()
  expect(first.items).toHaveLength(20)
  expect(first.next).toBeTruthy()
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(64 * 1024)
  expect(JSON.stringify(first)).not.toContain("aaaaa")
  const last = await integration.request("drafts.list", { cursor: first.next }, signal())
  expect(last.items).toHaveLength(3)
  expect(new Set([...first.items, ...last.items].map((entry) => entry.id)).size).toBe(23)
})

it("retains an interrupted-upload warning on mount until explicit dismissal", async () => {
  const key = composerScope("/repo", JSON.stringify(["", mocks.session!.sessionId]))
  draftStore(key).markUpload(true)
  resetDraftStoresForTest()
  mount({ projectCwd: "/repo" })
  expect((await list()).pendingUpload).toBe(true)
  await act(async () => { await integration.request("drafts.recover", { token: token(), action: "dismissUpload" }, signal()) })
  expect((await list()).pendingUpload).toBe(false)
})
