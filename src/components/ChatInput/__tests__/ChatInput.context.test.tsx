import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  session: { sessionId: "session-1" } as { sessionId: string } | null,
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
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
vi.mock("@/plugins/RuntimePluginActions", () => ({ RuntimePluginActions: () => null }))

import { ChatInput, type ChatInputHandle } from "../index"
import { renderComposerMessage, type ComposerContextItem } from "../../../../shared/session/composerContext"

const excerpt: ComposerContextItem = { id: "ctx-excerpt01", kind: "file", path: "src/app.ts", startLine: 4, endLine: 6, text: "const x = 1", comment: "Why?" }
const capture: ComposerContextItem = { id: "ctx-capture01", kind: "browser", note: "Overlap", url: "https://example.test", title: "Home", viewport: { width: 800, height: 600 }, region: { x: 0, y: 0, width: 100, height: 50 }, capturedAt: "2026-10-29T12:00:00.000Z", browser: "default", image: 1 }

function mount(props: Parameters<typeof ChatInput>[0] = {}) {
  const ref = createRef<ChatInputHandle>()
  const view = render(<ChatInput ref={ref} {...props} />)
  return { ref, ...view }
}

beforeEach(() => {
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
