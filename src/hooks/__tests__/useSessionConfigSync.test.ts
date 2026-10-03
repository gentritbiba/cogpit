import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useCallback, useState } from "react"
import { useSessionConfigSync, type ComposerConfigValues } from "../useSessionConfigSync"
import type { SessionConfig } from "@/lib/sessionConfig"
import { SESSION_CONFIG_CHANGED_EVENT } from "@/lib/sessionConfigEvents"
import type { SessionAccessState } from "@/lib/sessionAccessPermissions"

vi.mock("@/lib/sessionConfig", () => ({
  fetchSessionConfig: vi.fn(),
  saveSessionConfig: vi.fn(),
  flushSessionConfig: vi.fn(),
}))

import { fetchSessionConfig, flushSessionConfig, saveSessionConfig } from "@/lib/sessionConfig"

const mockFetch = fetchSessionConfig as unknown as ReturnType<typeof vi.fn>
const mockSave = saveSessionConfig as unknown as ReturnType<typeof vi.fn>
const mockFlush = vi.mocked(flushSessionConfig)

const VALUES: ComposerConfigValues = {
  model: "",
  effort: "high",
  contextWindowTokens: null,
  fastMode: false,
  ultracode: false,
  permissionMode: "bypassPermissions",
}

interface SyncProps {
  sessionKey: string | null
  access?: SessionAccessState
}

/** What App does with a hydrated config. */
function applyConfig(values: ComposerConfigValues, config: SessionConfig): ComposerConfigValues {
  return {
    model: config.model ?? values.model,
    effort: config.effort ?? values.effort,
    contextWindowTokens: config.contextWindowTokens ?? null,
    fastMode: config.fastMode ?? values.fastMode,
    ultracode: config.ultracode ?? values.ultracode,
    permissionMode: config.permissionMode || values.permissionMode,
  }
}

/** The hook under a composer whose values the hydration and the user both change. */
function renderSync(initial: SyncProps & { values?: ComposerConfigValues }) {
  const onHydrate = vi.fn()
  let setValues!: (update: (values: ComposerConfigValues) => ComposerConfigValues) => void
  const hook = renderHook(
    (props: SyncProps) => {
      const [values, set] = useState(initial.values ?? VALUES)
      setValues = set
      const hydrate = useCallback((config: SessionConfig) => {
        onHydrate(config)
        set((current) => applyConfig(current, config))
      }, [])
      const sync = useSessionConfigSync({
        sessionKey: props.sessionKey,
        sessionId: props.sessionKey?.replace(/\.jsonl$/, "") ?? null,
        access: props.access ?? "own",
        values,
        onHydrate: hydrate,
      })
      return { values, picked: sync.picked, settlePicked: sync.settlePicked }
    },
    { initialProps: { sessionKey: initial.sessionKey, access: initial.access } as SyncProps },
  )
  return {
    ...hook,
    onHydrate,
    pick: (patch: Partial<ComposerConfigValues>) => act(() => setValues((values) => ({ ...values, ...patch }))),
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

function signalConfigChanged(sessionId: string): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(SESSION_CONFIG_CHANGED_EVENT, { detail: { sessionId } }))
  })
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  act(() => { document.dispatchEvent(new Event("visibilitychange")) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(null)
  // A save stays unanswered, as one waiting out its debounce does, unless a test answers it.
  mockSave.mockReturnValue(new Promise<boolean>(() => {}))
  mockFlush.mockResolvedValue()
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
})

describe("useSessionConfigSync", () => {
  it("does nothing without a session key", async () => {
    renderSync({ sessionKey: null })
    await settle()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("hydrates the composer from the stored config when a session opens, without saving it back", async () => {
    mockFetch.mockResolvedValue({ model: "claude-opus-4-7", permissionMode: "acceptEdits" })

    const { result, onHydrate } = renderSync({ sessionKey: "session-a.jsonl" })

    await waitFor(() => {
      expect(onHydrate).toHaveBeenCalledWith({ model: "claude-opus-4-7", permissionMode: "acceptEdits" })
    })
    await settle()
    expect(result.current.values).toEqual({ ...VALUES, model: "claude-opus-4-7", permissionMode: "acceptEdits" })
    expect(result.current.picked).toEqual([])
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("seeds a session with nothing stored with the current values", async () => {
    mockFetch.mockResolvedValue({})

    renderSync({ sessionKey: "fresh.jsonl" })

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("fresh.jsonl", VALUES))
  })

  it("seeds a config that only has foreign fields (e.g. mcpServers)", async () => {
    mockFetch.mockResolvedValue({ mcpServers: ["clickup"] })

    const { onHydrate } = renderSync({ sessionKey: "mcp-only.jsonl" })

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("mcp-only.jsonl", VALUES))
    expect(onHydrate).not.toHaveBeenCalled()
  })

  it("seeds a session it does not own without this client's permission mode", async () => {
    mockFetch.mockResolvedValue({})

    renderSync({ sessionKey: "theirs.jsonl", access: "interact" })

    const { permissionMode: _mode, ...rest } = VALUES
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("theirs.jsonl", rest))
  })

  it("neither seeds nor saves when the read fails", async () => {
    // null = the read FAILED (offline/server restart) — distinct from `{}`,
    // which means "nothing stored". Seeding on failure would PUT this
    // client's local values over the session's real stored config.
    const { pick } = renderSync({ sessionKey: "flaky.jsonl" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("flaky.jsonl"))
    await settle()

    pick({ effort: "low" })
    await settle()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("saves only what the user changed after hydration", async () => {
    mockFetch.mockResolvedValue({ model: "claude-opus-4-7" })

    const { onHydrate, pick } = renderSync({ sessionKey: "session-a.jsonl" })
    await waitFor(() => expect(onHydrate).toHaveBeenCalled())
    await settle()

    pick({ permissionMode: "plan" })

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("session-a.jsonl", { permissionMode: "plan" }))
    expect(mockSave).toHaveBeenCalledOnce()
  })

  it("reads a session the user can only view but never writes to it", async () => {
    mockFetch.mockResolvedValue({ model: "claude-opus-4-7" })

    const { onHydrate, pick } = renderSync({ sessionKey: "shared.jsonl", access: "view" })
    await waitFor(() => expect(onHydrate).toHaveBeenCalledWith({ model: "claude-opus-4-7" }))

    pick({ effort: "low" })
    await settle()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("does not seed a session the user can only view", async () => {
    mockFetch.mockResolvedValue({})

    renderSync({ sessionKey: "shared.jsonl", access: "view" })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("shared.jsonl"))
    await settle()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("reads the stored config again when the access level changes", async () => {
    mockFetch.mockResolvedValue({ model: "alice-model", permissionMode: "default" })
    const { result, rerender } = renderSync({ sessionKey: "shared.jsonl", access: "view" })
    await waitFor(() => expect(result.current.values.model).toBe("alice-model"))

    mockFetch.mockResolvedValue({ model: "alice-model", permissionMode: "acceptEdits", effort: "low" })
    rerender({ sessionKey: "shared.jsonl", access: "interact" })

    await waitFor(() => expect(result.current.values).toMatchObject({ permissionMode: "acceptEdits", effort: "low" }))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result.current.picked).toEqual([])
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("seeds a session with nothing stored once it becomes writable", async () => {
    mockFetch.mockResolvedValue({})
    const { rerender } = renderSync({ sessionKey: "mine.jsonl", access: "unknown" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    await settle()
    expect(mockSave).not.toHaveBeenCalled()

    rerender({ sessionKey: "mine.jsonl", access: "own" })

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("mine.jsonl", VALUES))
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("keeps what the user picked before the session became writable, and saves only that", async () => {
    mockFetch.mockResolvedValue({ model: "stored-model" })
    const { result, rerender, pick } = renderSync({ sessionKey: "mine.jsonl", access: "unknown" })
    await waitFor(() => expect(result.current.values.model).toBe("stored-model"))

    pick({ effort: "low" })
    rerender({ sessionKey: "mine.jsonl", access: "own" })

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("mine.jsonl", { effort: "low" }))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result.current.values).toEqual({ ...VALUES, model: "stored-model", effort: "low" })
    expect(mockSave).toHaveBeenCalledOnce()
  })

  it("reads the config again when the session's stream says it changed", async () => {
    mockFetch.mockResolvedValue({ permissionMode: "default" })
    const { result } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.permissionMode).toBe("default"))

    mockFetch.mockResolvedValue({ permissionMode: "plan" })
    signalConfigChanged("other")
    await settle()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    signalConfigChanged("a")
    await waitFor(() => expect(result.current.values.permissionMode).toBe("plan"))
    expect(result.current.picked).toEqual([])
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("reads the config again when the window comes back after being hidden, once", async () => {
    mockFetch.mockResolvedValue({ effort: "high" })
    const { result } = renderSync({ sessionKey: "a.jsonl" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    act(() => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockResolvedValue({ effort: "low" })
    setVisibility("hidden")
    act(() => { window.dispatchEvent(new Event("focus")) })

    await waitFor(() => expect(result.current.values.effort).toBe("low"))
    expect(mockFetch).toHaveBeenCalledTimes(2)

    mockFetch.mockResolvedValue({ effort: "medium" })
    setVisibility("hidden")
    setVisibility("visible")
    act(() => { window.dispatchEvent(new Event("focus")) })

    await waitFor(() => expect(result.current.values.effort).toBe("medium"))
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("lets another user's later change win over this client's earlier, saved pick", async () => {
    mockFetch.mockResolvedValue({ permissionMode: "default" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.permissionMode).toBe("default"))

    pick({ permissionMode: "plan" })
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("a.jsonl", { permissionMode: "plan" }))
    expect([...result.current.picked]).toEqual(["permissionMode"])

    mockFetch.mockResolvedValue({ permissionMode: "acceptEdits" })
    signalConfigChanged("a")

    await waitFor(() => expect(result.current.values.permissionMode).toBe("acceptEdits"))
    expect(result.current.picked).toEqual([])
    expect(mockSave).toHaveBeenCalledOnce()
  })

  it("does not undo a change the user made while a read was out", async () => {
    mockFetch.mockResolvedValue({ effort: "high" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    await settle()

    let answer!: (config: SessionConfig) => void
    mockFetch.mockReturnValue(new Promise<SessionConfig>((resolve) => { answer = resolve }))
    signalConfigChanged("a")
    pick({ effort: "low" })
    await act(async () => answer({ effort: "high", model: "their-model" }))
    await settle()

    expect(result.current.values).toMatchObject({ effort: "low", model: "their-model" })
    expect([...result.current.picked]).toEqual(["effort"])
  })

  it("counts only what the user changed since the last read as picked", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))
    expect(result.current.picked).toEqual([])

    pick({ permissionMode: "plan" })
    expect([...result.current.picked]).toEqual(["permissionMode"])

    mockFetch.mockResolvedValue({ model: "m", permissionMode: "plan" })
    signalConfigChanged("a")
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await settle()
    expect(result.current.picked).toEqual([])
  })

  it("reads a reopened session before seeding it", async () => {
    mockFetch.mockResolvedValue({})
    const { rerender } = renderSync({ sessionKey: "a.jsonl", access: "view" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValue({ model: "b-model" })
    rerender({ sessionKey: "b.jsonl", access: "view" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await settle()

    let resolveA!: (config: SessionConfig) => void
    mockFetch.mockReturnValue(new Promise<SessionConfig>((resolve) => { resolveA = resolve }))
    rerender({ sessionKey: "a.jsonl", access: "own" })
    await settle()
    expect(mockFetch).toHaveBeenLastCalledWith("a.jsonl")
    expect(mockSave).not.toHaveBeenCalled()

    await act(async () => resolveA({}))
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("a.jsonl", { ...VALUES, model: "b-model" }))
    expect(mockSave).toHaveBeenCalledOnce()
  })

  it("does not seed a reopened session whose read found a stored config", async () => {
    mockFetch.mockResolvedValue({})
    const { rerender, onHydrate } = renderSync({ sessionKey: "a.jsonl", access: "view" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValue({ model: "b-model" })
    rerender({ sessionKey: "b.jsonl", access: "view" })
    await waitFor(() => expect(onHydrate).toHaveBeenCalledWith({ model: "b-model" }))

    mockFetch.mockResolvedValue({ model: "owner-model" })
    rerender({ sessionKey: "a.jsonl", access: "view" })
    await waitFor(() => expect(onHydrate).toHaveBeenCalledWith({ model: "owner-model" }))

    rerender({ sessionKey: "a.jsonl", access: "own" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4))
    await settle()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("re-hydrates when switching sessions, with one read per switch", async () => {
    mockFetch.mockResolvedValue({ model: "a-model" })
    const { rerender, onHydrate } = renderSync({ sessionKey: "session-a.jsonl" })
    await waitFor(() => expect(onHydrate).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValue({ model: "b-model" })
    rerender({ sessionKey: "session-b.jsonl", access: "interact" })

    await waitFor(() => expect(onHydrate).toHaveBeenCalledWith({ model: "b-model" }))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenLastCalledWith("session-b.jsonl")
  })

  it("hydrates a session's own context limit and clears it for a session with no override", async () => {
    mockFetch.mockResolvedValue({ contextWindowTokens: 1000000 })
    const { result, rerender } = renderSync({ sessionKey: "context-a.jsonl" })
    await waitFor(() => expect(result.current.values.contextWindowTokens).toBe(1000000))

    mockFetch.mockResolvedValue({ model: "default" })
    rerender({ sessionKey: "context-b.jsonl" })
    await waitFor(() => expect(result.current.values).toMatchObject({ model: "default", contextWindowTokens: null }))
    await settle()
    expect(mockSave).not.toHaveBeenCalled()
  })
  it("stops counting a pick once the server stored its save", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))

    let answer!: (stored: boolean) => void
    mockSave.mockReturnValueOnce(new Promise<boolean>((resolve) => { answer = resolve }))
    pick({ model: "sonnet" })
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("a.jsonl", { model: "sonnet" }))
    expect(result.current.picked).toEqual(["model"])

    await act(async () => answer(true))
    expect(result.current.picked).toEqual([])
  })

  it("keeps counting a pick whose save the server did not store", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    mockSave.mockResolvedValue(false)
    const { result, pick } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))

    pick({ model: "sonnet" })
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    await settle()
    expect(result.current.picked).toEqual(["model"])
  })

  it("keeps counting a pick the user changed again while its earlier save was out", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))

    let answer!: (stored: boolean) => void
    mockSave.mockReturnValueOnce(new Promise<boolean>((resolve) => { answer = resolve }))
    pick({ model: "sonnet" })
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("a.jsonl", { model: "sonnet" }))
    pick({ model: "haiku" })

    await act(async () => answer(true))
    expect(result.current.picked).toEqual(["model"])
  })

  it("sends the session's waiting saves at once when a send carrying the picks went through", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    const { result, pick } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))
    pick({ model: "sonnet" })

    act(() => result.current.settlePicked())

    expect(mockFlush).toHaveBeenCalledWith("a.jsonl")
  })

  it("hands out the same picked list while nothing it counts changes", async () => {
    mockFetch.mockResolvedValue({ model: "m" })
    const { result, pick, rerender } = renderSync({ sessionKey: "a.jsonl", access: "interact" })
    await waitFor(() => expect(result.current.values.model).toBe("m"))
    pick({ effort: "low" })
    const picked = result.current.picked

    rerender({ sessionKey: "a.jsonl", access: "interact" })

    expect(result.current.picked).toBe(picked)
  })
})
