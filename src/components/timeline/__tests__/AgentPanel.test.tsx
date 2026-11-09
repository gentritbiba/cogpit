import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InSession } from "@/__tests__/InSession"
import type { SessionControls } from "@/contexts/SessionContext"
import type { SubAgentMessage } from "../../../../shared/session/types"
import type { SessionView } from "../../../../shared/session/sessionDigest"
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

const SESSION = { sessionId: "sess-1", turns: [] } as unknown as SessionView

function renderPanel(messages: SubAgentMessage[] = [summaryOnlyAgent()]) {
  const controls = {
    sessionSource: { dirName: "-Users-me-proj", fileName: "sess-1.jsonl" },
    isLive: false,
    actions: { handleLoadSession: vi.fn() },
  } as unknown as SessionControls

  return render(
    <InSession session={SESSION} controls={controls}>
      <AgentPanel
        messages={messages}
        expandAll
        label="Sub-agents"
        countLabel="agents"
      />
    </InSession>,
  )
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ headerLines: [], tailLines: [], byteOffset: 0, hasMore: false }) })
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
      "/api/sessions/-Users-me-proj/sess-1/subagents/agent-ag1.jsonl?tail=1&projection=results-v1",
    )
  })

  it("stays quiet when the agent's transcript is already inline", () => {
    window.history.pushState({}, "", "/shared/sess-1")
    renderPanel([{ ...summaryOnlyAgent(), text: ["done"] }])
    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    expect(screen.getByText("done")).toBeInTheDocument()
  })
})

describe("AgentPanel nesting and run settings", () => {
  function agent(agentId: string, extra: Partial<SubAgentMessage>): SubAgentMessage {
    return { ...summaryOnlyAgent(), agentId, status: "completed", text: [`${agentId} said`], ...extra }
  }

  it("lists a nested agent under its parent and shows each agent's model and requested effort", () => {
    renderPanel([
      agent("outer1234", { model: "claude-haiku-4-5-20251001", effort: "low", parentToolUseId: "tool-outer" }),
      agent("twin5678", { parentToolUseId: "tool-twin" }),
      agent("inner9012", { parentAgentId: "outer1234", effort: "high", parentToolUseId: "tool-inner" }),
    ])

    const said = screen.getAllByText(/ said$/).map((node) => node.textContent)
    expect(said).toEqual(["outer1234 said", "inner9012 said", "twin5678 said"])
    expect(screen.getByText("Haiku 4.5 · low effort")).toBeInTheDocument()
    expect(screen.getByText("high effort")).toBeInTheDocument()
    expect(screen.getByText("inner9012 said").closest(".border-l")).toHaveClass("ml-4")
    expect(screen.getByText("outer1234 said").closest(".border-l")).not.toHaveClass("ml-4")
  })
})

describe("AgentPanel terminal states", () => {
  function ended(status: string, text: string[] = []): SubAgentMessage {
    return { ...summaryOnlyAgent(), isBackground: false, parentToolUseId: "tool-1", durationMs: 4_000, status, text }
  }

  it.each([
    ["failed", "Failed", "text-destructive"],
    ["errored", "Failed", "text-destructive"],
    ["interrupted", "Interrupted", "text-warning"],
    ["cancelled", "Cancelled", "text-warning"],
  ])("says a %s agent with no reply ended, instead of working forever", (status, label, tone) => {
    renderPanel([ended(status)])
    expect(screen.getByText(label)).toHaveClass(tone)
    expect(screen.getByText(`${label} before returning anything`)).toBeInTheDocument()
    expect(screen.queryByText("Working — no return yet")).toBeNull()
  })

  it("keeps the failure beside the error a failed agent reported", () => {
    renderPanel([ended("failed", ["Rate limited by the provider"])])
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("Rate limited by the provider")).toBeInTheDocument()
  })

  it("still shows an agent without a final status as working", () => {
    renderPanel([ended("running")])
    expect(screen.getByText("Working — no return yet")).toBeInTheDocument()
    expect(screen.queryByText(/before returning anything/)).toBeNull()
  })
})
