import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useSessionConfigSync, type ComposerConfigValues } from "../useSessionConfigSync"
import type { SessionConfig } from "@/lib/sessionConfig"

vi.mock("@/lib/sessionConfig", () => ({
  fetchSessionConfig: vi.fn(),
  saveSessionConfig: vi.fn(),
}))

import { fetchSessionConfig, saveSessionConfig } from "@/lib/sessionConfig"

const mockFetch = fetchSessionConfig as unknown as ReturnType<typeof vi.fn>
const mockSave = saveSessionConfig as unknown as ReturnType<typeof vi.fn>

const VALUES: ComposerConfigValues = {
  model: "",
  effort: "high",
  fastMode: false,
  ultracode: false,
  permissionMode: "bypassPermissions",
}

function renderSync(initial: {
  sessionKey: string | null
  values?: ComposerConfigValues
  onHydrate?: (config: SessionConfig) => void
}) {
  return renderHook(
    (props: { sessionKey: string | null; values: ComposerConfigValues }) =>
      useSessionConfigSync({
        sessionKey: props.sessionKey,
        values: props.values,
        onHydrate: initial.onHydrate ?? vi.fn(),
      }),
    { initialProps: { sessionKey: initial.sessionKey, values: initial.values ?? VALUES } },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(null)
})

describe("useSessionConfigSync", () => {
  it("does nothing without a session key", async () => {
    renderSync({ sessionKey: null })
    await Promise.resolve()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("hydrates the UI from stored config when a session opens", async () => {
    const onHydrate = vi.fn()
    mockFetch.mockResolvedValue({ model: "claude-opus-4-7", permissionMode: "acceptEdits" })

    renderSync({ sessionKey: "session-a.jsonl", onHydrate })

    await waitFor(() => {
      expect(onHydrate).toHaveBeenCalledWith({
        model: "claude-opus-4-7",
        permissionMode: "acceptEdits",
      })
    })
    // Nothing changed locally — no save echo.
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("seeds an empty config with the current values", async () => {
    mockFetch.mockResolvedValue({})

    renderSync({ sessionKey: "fresh.jsonl" })

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith("fresh.jsonl", VALUES)
    })
  })

  it("ignores a config that only has foreign fields (e.g. mcpServers)", async () => {
    const onHydrate = vi.fn()
    mockFetch.mockResolvedValue({ mcpServers: ["clickup"] })

    renderSync({ sessionKey: "mcp-only.jsonl", onHydrate })

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith("mcp-only.jsonl", VALUES)
    })
    expect(onHydrate).not.toHaveBeenCalled()
  })

  it("does not seed or persist when the config fetch fails", async () => {
    // null = fetch FAILED (offline/server restart) — distinct from `{}`,
    // which means "nothing stored". Seeding on failure would PUT this
    // client's local values over the session's real stored config.
    mockFetch.mockResolvedValue(null)

    const { rerender } = renderSync({ sessionKey: "flaky.jsonl" })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("flaky.jsonl"))
    expect(mockSave).not.toHaveBeenCalled()

    // Later local changes must not persist either — hydration never completed.
    rerender({ sessionKey: "flaky.jsonl", values: { ...VALUES, effort: "low" } })
    await Promise.resolve()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("persists changes made after hydration", async () => {
    const onHydrate = vi.fn()
    mockFetch.mockResolvedValue({ model: "claude-opus-4-7" })

    const { rerender } = renderSync({ sessionKey: "session-a.jsonl", onHydrate })
    await waitFor(() => expect(onHydrate).toHaveBeenCalled())

    const changed = { ...VALUES, permissionMode: "plan" as const }
    rerender({ sessionKey: "session-a.jsonl", values: changed })

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith("session-a.jsonl", changed)
    })
  })

  it("re-hydrates when switching sessions", async () => {
    const onHydrate = vi.fn()
    mockFetch.mockResolvedValue({ model: "a-model" })

    const { rerender } = renderSync({ sessionKey: "session-a.jsonl", onHydrate })
    await waitFor(() => expect(onHydrate).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValue({ model: "b-model" })
    rerender({ sessionKey: "session-b.jsonl", values: VALUES })

    await waitFor(() => {
      expect(onHydrate).toHaveBeenCalledWith({ model: "b-model" })
    })
    expect(mockFetch).toHaveBeenCalledWith("session-b.jsonl")
  })
})
