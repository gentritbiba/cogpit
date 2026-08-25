import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SessionProvider,
  type SessionChatContextValue,
  type SessionContextValue,
} from "@/contexts/SessionContext"
import type { ParsedSession, SubAgentMessage } from "@/lib/types"
import { AgentPanel } from "../AgentPanel"

const authFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ authFetch }))

const UNAVAILABLE = "Sub-agent transcripts aren't available in a shared session."

/**
 * A launch-event summary with no transcript inline — the only shape that makes
 * the panel fetch `.../subagents/agent-N.jsonl`, and so the only one a guest
 * can see fail.
 */
function summaryOnlyAgent(): SubAgentMessage {
  return {
    agentId: "ag1",
    agentName: "explorer",
    subagentType: "Explore",
    type: "assistant",
    content: null,
    toolCalls: [],
    thinking: [],
    text: [],
    timestamp: "2026-08-25T10:00:00Z",
    tokenUsage: null,
    model: null,
    isBackground: true,
    status: "async_launched",
  }
}

function renderPanel(messages: SubAgentMessage[] = [summaryOnlyAgent()]) {
  const value = {
    session: { sessionId: "sess-1", rawMessages: [], turns: [] } as unknown as ParsedSession,
    sessionSource: { dirName: "-Users-me-proj", fileName: "sess-1.jsonl" },
    isLive: false,
    actions: { handleLoadSession: vi.fn() },
  } as unknown as SessionContextValue

  return render(
    <SessionProvider value={value} chatValue={{} as SessionChatContextValue}>
      <AgentPanel
        messages={messages}
        expandAll
        label="Sub-agents"
        countLabel="agents"
        lazyLoad
      />
    </SessionProvider>,
  )
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue({ ok: true, text: async () => "" })
  window.history.pushState({}, "", "/")
})

afterEach(() => {
  cleanup()
  window.history.pushState({}, "", "/")
})

describe("AgentPanel on a shared session", () => {
  it("says why the transcript is missing instead of expanding to nothing", () => {
    window.history.pushState({}, "", "/shared/sess-1")
    renderPanel()
    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument()
  })

  it("does not fire a request the guest allowlist would refuse", () => {
    window.history.pushState({}, "", "/shared/sess-1")
    renderPanel()
    expect(authFetch).not.toHaveBeenCalled()
  })

  it("hides the open-chat button, which a guest cannot act on", () => {
    window.history.pushState({}, "", "/shared/sess-1")
    renderPanel()
    expect(screen.queryByRole("button", { name: /open chat/i })).toBeNull()
  })

  it("says nothing of the sort for the host, who can load the file", () => {
    renderPanel()
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    expect(authFetch).toHaveBeenCalledWith(
      "/api/sessions/-Users-me-proj/sess-1/subagents/agent-ag1.jsonl",
    )
  })

  it("stays quiet when the agent's transcript is already inline", () => {
    window.history.pushState({}, "", "/shared/sess-1")
    renderPanel([{ ...summaryOnlyAgent(), text: ["done"] }])
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    expect(screen.getByText("done")).toBeInTheDocument()
  })
})
