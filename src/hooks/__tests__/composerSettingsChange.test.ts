import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useState } from "react"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  fetchSessionConfig: vi.fn(),
  saveSessionConfig: vi.fn(),
  flushSessionConfig: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/sessionConfig", () => ({
  fetchSessionConfig: mocks.fetchSessionConfig,
  saveSessionConfig: mocks.saveSessionConfig,
  flushSessionConfig: mocks.flushSessionConfig,
}))

import { usePtyChat } from "../usePtyChat"
import { useSessionConfigSync, type ComposerConfigValues } from "../useSessionConfigSync"

const STORED: ComposerConfigValues = {
  model: "opus",
  effort: "high",
  contextWindowTokens: null,
  fastMode: true,
  ultracode: false,
  permissionMode: "default",
}

/** The composer's settings, synced with the session's stored config and sent with its messages as App wires them. */
function renderComposer() {
  let setValues!: (update: (values: ComposerConfigValues) => ComposerConfigValues) => void
  const hook = renderHook(() => {
    const [values, set] = useState(STORED)
    setValues = set
    const { picked, settlePicked } = useSessionConfigSync({
      sessionKey: "sess.jsonl",
      sessionId: "sess",
      access: "interact",
      values,
      onHydrate: () => {},
    })
    return usePtyChat({
      sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      parsedSessionId: "sess",
      model: values.model,
      effort: values.effort,
      contextWindowTokens: values.contextWindowTokens,
      fastMode: values.fastMode,
      ultracode: values.ultracode,
      settingsChange: picked,
      onSettingsChangeSent: settlePicked,
    })
  })
  return {
    ...hook,
    pick: (patch: Partial<ComposerConfigValues>) => act(() => setValues((values) => ({ ...values, ...patch }))),
  }
}

async function send(chat: { current: { sendMessage: (text: string) => Promise<boolean> } }): Promise<Record<string, unknown>> {
  await act(async () => {
    await chat.current.sendMessage("go on")
  })
  const [url, init] = mocks.authFetch.mock.calls.at(-1) as [string, RequestInit]
  expect(url).toBe("/api/send-message")
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** The composer once the session's stored config was read. */
async function openComposer() {
  const composer = renderComposer()
  await waitFor(() => expect(mocks.fetchSessionConfig).toHaveBeenCalledWith("sess.jsonl"))
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
  return composer
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchSessionConfig.mockResolvedValue(STORED)
  // A pick's save waits out its debounce until a test lets it through.
  mocks.saveSessionConfig.mockReturnValue(new Promise<boolean>(() => {}))
  mocks.flushSessionConfig.mockResolvedValue(undefined)
  mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ success: true })))
})

describe("a send right after the user picks a setting", () => {
  it("names the picked model in settingsChange, carrying it, before its save went out", async () => {
    const { result, pick } = await openComposer()

    pick({ model: "sonnet" })
    const body = await send(result)

    expect(body).toMatchObject({ model: "sonnet", settingsChange: ["model"] })
    expect(mocks.saveSessionConfig).toHaveBeenCalledWith("sess.jsonl", { model: "sonnet" })
  })

  it("never names a setting the user left alone", async () => {
    const { result, pick } = await openComposer()

    expect(await send(result)).not.toHaveProperty("settingsChange")

    pick({ fastMode: false })
    const body = await send(result)
    expect(body).toMatchObject({ fastMode: false, settingsChange: ["fastMode"] })
  })

  it("stops naming a pick once the send went through and its save was stored", async () => {
    let answerSave!: (stored: boolean) => void
    mocks.saveSessionConfig.mockReturnValue(new Promise<boolean>((resolve) => { answerSave = resolve }))
    mocks.flushSessionConfig.mockImplementation(async () => answerSave(true))
    const { result, pick } = await openComposer()

    pick({ model: "sonnet" })
    expect(await send(result)).toMatchObject({ settingsChange: ["model"] })
    expect(mocks.flushSessionConfig).toHaveBeenCalledWith("sess.jsonl")

    const next = await send(result)
    expect(next).toMatchObject({ model: "sonnet" })
    expect(next).not.toHaveProperty("settingsChange")
  })

  it("keeps naming a pick after a send that failed", async () => {
    mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Server error" }), { status: 500 }))
    const { result, pick } = await openComposer()

    pick({ effort: "low" })
    await send(result)
    expect(mocks.flushSessionConfig).not.toHaveBeenCalled()

    expect(await send(result)).toMatchObject({ effort: "low", settingsChange: ["effort"] })
  })
})
