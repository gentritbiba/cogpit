import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { AgentKind } from "@/lib/sessionSource"

const mocks = vi.hoisted(() => ({
  agentKind: "claude" as AgentKind,
  interrupt: vi.fn(),
  stopSession: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    isLive: true,
    sessionSource: {
      dirName: "project",
      fileName: "session.jsonl",
      rawText: "",
      agentKind: mocks.agentKind,
    },
    actions: { handleStopSession: mocks.stopSession },
  }),
  useSessionChatContext: () => ({
    chat: { isConnected: true, interrupt: mocks.interrupt },
  }),
}))

import { ActionButtons } from "../InputToolbar"

beforeEach(() => {
  mocks.agentKind = "claude"
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ActionButtons", () => {
  it.each([
    ["claude", "Interrupt agent"],
    ["codex", "Stop active turn"],
    ["copilot", "Stop Copilot turn"],
  ] as const)("uses the %s interrupt label", (agentKind, label) => {
    mocks.agentKind = agentKind

    render(<ActionButtons hasContent={false} onSubmit={vi.fn()} />)

    expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
  })
})
