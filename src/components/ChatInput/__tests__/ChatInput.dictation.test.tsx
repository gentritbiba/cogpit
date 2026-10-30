import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposerDictation, DictationState } from "@/plugins/RuntimeDictation"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  restoreImages: vi.fn(),
  clearImages: vi.fn(),
  images: [] as Array<{ id: string; data: string; mediaType: string }>,
  session: { sessionId: "session-one" } as { sessionId: string } | null,
  dictation: null as unknown as ComposerDictation & { state: DictationState },
  onTranscript: null as null | ((text: string, send: boolean) => void),
  update: () => {},
}))

vi.mock("@/contexts/SessionContext", () => ({
  // No plugin runtime is mounted here, so composer plugins never read these.
  useSessionContextOptional: () => null,
  useSessionChatContextOptional: () => null,
  useSessionContext: () => ({
    session: mocks.session,
    isLive: false,
    actions: { handleEditConfig: vi.fn() },
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
vi.mock("@/hooks/useElapsedTimer", () => ({ useElapsedTimer: () => 0 }))
vi.mock("@/hooks/useProjectFileSuggestions", () => ({
  useProjectFileSuggestions: () => ({ files: [], loading: false }),
}))
vi.mock("../useImageUpload", () => ({
  useImageUpload: () => ({
    images: mocks.images,
    isDragOver: false,
    imageError: null,
    hasUnsupportedAttachments: false,
    dismissImageError: vi.fn(),
    removeImage: vi.fn(),
    clearImages: mocks.clearImages,
    restoreImages: mocks.restoreImages,
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
  }),
}))
vi.mock("@/components/SlashSuggestions", () => ({ SlashSuggestions: () => null }))
vi.mock("@/components/FileSuggestions", () => ({ FileSuggestions: () => null }))

vi.mock("@/plugins/RuntimeDictation", async () => {
  const { useReducer } = await import("react")
  return {
  useComposerDictation: (onTranscript: (text: string, send: boolean) => void) => {
    const [, update] = useReducer((count: number) => count + 1, 0)
    mocks.update = update
    mocks.onTranscript = onTranscript
    return mocks.dictation
  },
  DictationButton: ({ dictation }: { dictation: ComposerDictation }): ReactNode => <button type="button" onClick={dictation.start}>Dictate</button>,
  DictationBar: (): ReactNode => <div>Recording</div>,
  }
})

import { ChatInput } from "../index"

beforeEach(() => {
  mocks.sendMessage.mockReset().mockResolvedValue(true)
  mocks.dictation = { title: "Dictate", state: { status: "idle" }, start: vi.fn(), finish: vi.fn(), cancel: vi.fn(), retry: vi.fn(), level: () => 0 }
})
const message = () => screen.getByRole("combobox", { name: "Message" })
const dictationState = (state: DictationState) => act(() => { mocks.dictation = { ...mocks.dictation, state }; mocks.update() })

describe("ChatInput dictation", () => {
  it("continues the draft with the spoken text and leaves it to edit", () => {
    render(<ChatInput />)
    fireEvent.change(message(), { target: { value: "Fix the" } })
    act(() => mocks.onTranscript!("login bug.", false))
    expect(message()).toHaveValue("Fix the login bug.")
    act(() => mocks.onTranscript!("Thanks.", false))
    expect(message()).toHaveValue("Fix the login bug. Thanks.")
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
  it("sends the whole draft when the transcript was asked to send", () => {
    render(<ChatInput />)
    fireEvent.change(message(), { target: { value: "Note:\n" } })
    act(() => mocks.onTranscript!("ship it", true))
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith("Note:\nship it", undefined)
  })
  it("turns Send and Enter into transcribe-and-send while recording, and Escape discards", () => {
    render(<ChatInput />)
    dictationState({ status: "recording" })
    expect(screen.getByText("Recording")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and send" }))
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(mocks.dictation.finish).toHaveBeenCalledTimes(2)
    expect(mocks.dictation.finish).toHaveBeenCalledWith(true)
    fireEvent.keyDown(message(), { key: "Escape" })
    expect(mocks.dictation.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
  it("holds typed text while a take is transcribing, then sends normally after a failure", () => {
    render(<ChatInput />)
    fireEvent.change(message(), { target: { value: "typed" } })
    dictationState({ status: "transcribing" })
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    dictationState({ status: "failed", message: "The speech service didn't answer. Try again.", retry: true })
    fireEvent.keyDown(message(), { key: "Enter" })
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith("typed", undefined)
  })
})
