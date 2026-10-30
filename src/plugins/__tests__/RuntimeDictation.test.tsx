import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseManifest } from "@cogpit/plugin-contracts"
import { DictationBar, DictationButton, useComposerDictation } from "../RuntimeDictation"
import { PluginRequestError } from "../runtimeClient"

const state = vi.hoisted(() => ({
  runtime: null as unknown,
  session: { session: { sessionId: "session-one" }, permissions: { send: true } },
  recording: { level: vi.fn(() => 0.5), stop: vi.fn<() => Promise<Blob>>(), cancel: vi.fn() },
  startRecording: vi.fn<() => Promise<unknown>>(),
}))
vi.mock("../RuntimePluginContributions", () => ({ useRuntimeContributions: () => state.runtime }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContextOptional: () => state.session, useSessionChatContextOptional: () => ({ chat: { sendMessage: vi.fn() } }) }))
vi.mock("../runtimeClient", async importOriginal => ({ ...await importOriginal<typeof import("../runtimeClient")>(),
  clientRuntimeDescriptor: () => ({ appVersion: "3.5.1", apiVersions: ["1.3.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, browser: [] }) }))
vi.mock("../dictation/recorder", () => ({ canRecord: () => true, MAX_DICTATION_SECONDS: 240, startRecording: state.startRecording }))
vi.mock("../dictation/DictationWaveform", () => ({ DictationWaveform: () => <div data-testid="level-meter" /> }))

const manifest = parseManifest({ manifestVersion: 1, id: "example.speech", publisher: "example", name: "Speech", version: "1.1.0", runtime: "browser-iife-v1", engines: { pluginApi: "^1.3.0", client: "*", host: "*" }, requires: { client: {}, host: {} }, stateVersion: 1,
  permissions: { connections: [{ id: "speech", definition: "speech.json", operations: ["transcribe"] }] },
  contributes: { dictation: { title: "Dictate", connection: "speech", operation: "transcribe", text: "/text" } } })
const wav = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" })
function runtime(configured = true) {
  const client = {
    lease: vi.fn(async () => ({ id: `lease-${Math.random()}`, expiresAt: Date.now() + 30_000 })),
    revokeLease: vi.fn(async () => {}),
    call: vi.fn(async () => ({ configured, readOnly: false, selected: {} })),
    dictate: vi.fn<(leaseId: string, recording: Blob, signal?: AbortSignal) => Promise<string>>(async () => " Hello there. "),
  }
  return { client, activation: "host-one", project: null, workspacePath: null, status: { safeMode: false, runtime: { appVersion: "3.5.1", apiVersions: ["1.3.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "darwin", registryRevision: 1 },
    store: { available: true, plugins: [{ id: manifest.id, manifest, enabled: true, scope: { type: "all" }, selectedDigest: "a".repeat(64) }] } } }
}
const client = () => (state.runtime as ReturnType<typeof runtime>).client

function Composer({ onTranscript }: { onTranscript: (text: string, send: boolean) => void }) {
  const dictation = useComposerDictation(onTranscript)
  if (!dictation) return null
  return <>
    {dictation.state.status === "idle" ? <DictationButton dictation={dictation} /> : <DictationBar dictation={dictation} />}
    <button type="button" onClick={() => dictation.finish(true)}>Send</button>
  </>
}
async function record(onTranscript = vi.fn()) {
  const view = render(<Composer onTranscript={onTranscript} />)
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop and insert text" })).toBeEnabled())
  return { view, onTranscript }
}

beforeEach(() => {
  state.runtime = runtime()
  state.session.session.sessionId = "session-one"
  state.recording.stop.mockReset().mockResolvedValue(wav)
  state.recording.cancel.mockReset()
  state.startRecording.mockReset().mockResolvedValue(state.recording)
})
afterEach(() => { state.runtime = null })

describe("composer dictation", () => {
  it("records only after the user asks, then puts the transcript into the draft on Stop", async () => {
    const { onTranscript } = await record()
    expect(state.startRecording).toHaveBeenCalledOnce()
    expect(screen.getByTestId("level-meter")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop and insert text" }))
    await waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Hello there.", false))
    expect(client().dictate).toHaveBeenCalledWith(expect.stringMatching(/^lease-/), wav, expect.any(AbortSignal))
    expect(client().revokeLease).toHaveBeenCalledTimes(client().lease.mock.calls.length)
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument()
  })
  it("sends the transcript with the composer's Send while recording", async () => {
    const { onTranscript } = await record()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Hello there.", true))
  })
  it("keeps the take after a service failure so it can be retried", async () => {
    client().dictate.mockRejectedValueOnce(new PluginRequestError("Connection operation failed", "UPSTREAM_FAILED", 400))
    const { onTranscript } = await record()
    fireEvent.click(screen.getByRole("button", { name: "Stop and insert text" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("didn't answer")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Hello there.", false))
    expect(client().dictate.mock.calls.map(call => call[1])).toEqual([wav, wav])
    expect(state.recording.stop).toHaveBeenCalledOnce()
  })
  it("turns the microphone off and explains setup when the speech service is not connected", async () => {
    state.runtime = runtime(false)
    render(<Composer onTranscript={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect the speech service in Plugins, under Speech.")
    expect(state.recording.cancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })
  it("explains a blocked microphone", async () => {
    state.startRecording.mockRejectedValue(new DOMException("denied", "NotAllowedError"))
    render(<Composer onTranscript={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone access is blocked")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument()
  })
  it("reports silence instead of inserting nothing", async () => {
    client().dictate.mockResolvedValue("  ")
    const { onTranscript } = await record()
    fireEvent.click(screen.getByRole("button", { name: "Stop and insert text" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("No speech was heard.")
    expect(onTranscript).not.toHaveBeenCalled()
  })
  it("discards the take when the composer moves to another session", async () => {
    const { view, onTranscript } = await record()
    state.session.session.sessionId = "session-two"
    view.rerender(<Composer onTranscript={onTranscript} />)
    expect(state.recording.cancel).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument()
    expect(client().dictate).not.toHaveBeenCalled()
  })
  it("offers nothing without a plugin that declares dictation", () => {
    state.runtime = null
    render(<Composer onTranscript={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull()
  })
})
