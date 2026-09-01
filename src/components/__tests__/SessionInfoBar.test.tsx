import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ParsedSession } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  session: null as ParsedSession | null,
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ isMobile: true }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: null,
  }),
}))

vi.mock("@/components/SessionInfoBar.mobile", () => ({
  MobileSessionInfoBar: ({ claudeRawMessages }: { claudeRawMessages: unknown[] }) => (
    <div data-testid="claude-raw-count">{claudeRawMessages.length}</div>
  ),
}))

import { SessionInfoBar } from "../SessionInfoBar"

function makeSession(agentKind: ParsedSession["agentKind"]): ParsedSession {
  return {
    agentKind,
    rawMessages: [{ type: "assistant" }],
  } as ParsedSession
}

beforeEach(() => {
  mocks.session = null
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SessionInfoBar", () => {
  it("passes Claude records to the context badge", () => {
    mocks.session = makeSession("claude")

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("claude-raw-count")).toHaveTextContent("1")
  })

  it.each(["codex", "copilot"] as const)("does not treat %s records as Claude usage", (agentKind) => {
    mocks.session = makeSession(agentKind)

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("claude-raw-count")).toHaveTextContent("0")
  })
})
