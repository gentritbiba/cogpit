import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { AgentKind } from "@/lib/sessionSource"
import type { ModelOption } from "@/lib/utils"

const modelOptions: Record<AgentKind, ModelOption[]> = {
  claude: [
    { value: "", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
}

vi.mock("@/hooks/useModelOptions", () => ({
  useModelOptions: (agentKind: AgentKind) => modelOptions[agentKind],
}))

import { useComposerSettings } from "@/hooks/useComposerSettings"

const sessionSource: SessionSource = {
  dirName: "-repo",
  fileName: "session.jsonl",
  rawText: "",
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "session-id",
    version: "1",
    gitBranch: "main",
    cwd: "/repo",
    slug: "session",
    name: "Session",
    model: "opus",
    turns: [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
    agentKind: "claude",
    ...overrides,
  }
}

function renderSettings(initial: {
  agentKind?: AgentKind
  session?: ParsedSession | null
  source?: SessionSource | null
  pendingDirName?: string | null
  isLive?: boolean
} = {}) {
  return renderHook(
    (props: typeof initial) => useComposerSettings({
      agentKind: props.agentKind,
      session: props.session ?? null,
      sessionSource: props.source ?? null,
      pendingDirName: props.pendingDirName ?? null,
      isLive: props.isLive ?? false,
    }),
    { initialProps: initial },
  )
}

describe("useComposerSettings", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("derives provider capabilities and pins ultracode to xhigh", () => {
    const { result } = renderSettings({ agentKind: "claude", session: makeSession() })

    expect(result.current.selectedModel).toBe("")
    expect(result.current.effectiveEffort).toBe("high")
    expect(result.current.ultracodeAvailable).toBe(true)
    expect(result.current.fastModeAvailable).toBe(false)
    expect(result.current.imageInputAvailable).toBe(true)

    act(() => result.current.setUltracodeEnabled(true))
    expect(result.current.ultracodeActive).toBe(true)
    expect(result.current.effectiveEffort).toBe("xhigh")
  })

  it("exposes Codex fast mode but never enables Claude-only ultracode", () => {
    const { result } = renderSettings({ agentKind: "codex" })

    act(() => {
      result.current.setSelectedModel("gpt-5.6-sol")
      result.current.setFastModeEnabled(true)
      result.current.setUltracodeEnabled(true)
    })

    expect(result.current.effectiveEffort).toBe("medium")
    expect(result.current.fastModeAvailable).toBe(true)
    expect(result.current.fastModeActive).toBe(true)
    expect(result.current.ultracodeAvailable).toBe(false)
    expect(result.current.ultracodeActive).toBe(false)
  })

  it("clears a selected model when the active provider does not offer it", async () => {
    const { result, rerender } = renderSettings({
      agentKind: "claude",
      source: sessionSource,
    })

    act(() => result.current.setSelectedModel("opus"))
    expect(result.current.selectedModel).toBe("opus")

    rerender({ agentKind: "codex", source: sessionSource })
    await waitFor(() => expect(result.current.selectedModel).toBe(""))
  })

  it("clears only the rejected Codex model and keeps its callback stable", () => {
    const { result } = renderSettings({ agentKind: "codex", source: sessionSource })
    const reject = result.current.handleCodexModelRejected

    act(() => result.current.setSelectedModel("gpt-5.6-sol"))
    act(() => result.current.handleCodexModelRejected("another-model"))
    expect(result.current.selectedModel).toBe("gpt-5.6-sol")

    act(() => result.current.handleCodexModelRejected("gpt-5.6-sol"))
    expect(result.current.selectedModel).toBe("")
    expect(result.current.modelFallbackNotice).toContain("gpt-5.6-sol is unavailable")
    expect(result.current.handleCodexModelRejected).toBe(reject)
  })

  it("reports the latest live Claude fallback once and supports dismissal", async () => {
    const session = makeSession({
      rawMessages: [
        {
          type: "system",
          subtype: "model_refusal_fallback",
          uuid: "fallback-1",
          original_model: "Fable",
          fallback_model: "Opus",
          api_refusal_explanation: "Capacity was unavailable.",
        },
      ],
    })
    const { result, rerender } = renderSettings({
      agentKind: "claude",
      session,
      source: sessionSource,
      isLive: true,
    })

    await waitFor(() => {
      expect(result.current.modelFallbackNotice).toBe(
        "Fable could not handle this request, so Claude continued with Opus. Capacity was unavailable.",
      )
    })

    act(() => result.current.dismissModelFallbackNotice())
    expect(result.current.modelFallbackNotice).toBeNull()

    rerender({ agentKind: "claude", session: { ...session }, source: sessionSource, isLive: true })
    expect(result.current.modelFallbackNotice).toBeNull()
  })

  it("auto-dismisses fallback notices after twelve seconds", () => {
    vi.useFakeTimers()
    const session = makeSession({
      rawMessages: [{
        type: "system",
        subtype: "model_refusal_fallback",
        uuid: "fallback-timer",
        original_model: "Fable",
        fallback_model: "Opus",
      }],
    })
    const { result } = renderSettings({
      agentKind: "claude",
      session,
      source: sessionSource,
      isLive: true,
    })

    expect(result.current.modelFallbackNotice).not.toBeNull()
    act(() => vi.advanceTimersByTime(12_000))
    expect(result.current.modelFallbackNotice).toBeNull()
  })
})
