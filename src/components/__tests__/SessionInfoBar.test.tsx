import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ParsedSession } from "../../../shared/session/types"

const mocks = vi.hoisted(() => ({
  session: null as ParsedSession | null,
  dirName: null as string | null,
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ isMobile: true }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.dirName === null
      ? null
      : { dirName: mocks.dirName, fileName: "s.jsonl", rawText: "" },
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
  mocks.dirName = null
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SessionInfoBar", () => {
  it("passes records to the context badge for an agent that tracks context", () => {
    mocks.session = makeSession("claude")
    mocks.dirName = "-Users-me-proj"

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("claude-raw-count")).toHaveTextContent("1")
  })

  it.each([
    ["codex", "codex__L3RtcC9wcm9qZWN0"],
    ["copilot", "copilot__L3RtcC9wcm9qZWN0"],
  ] as const)("withholds records for %s, which reports no context window", (agentKind, dirName) => {
    mocks.session = makeSession(agentKind)
    mocks.dirName = dirName

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("claude-raw-count")).toHaveTextContent("0")
  })

  it("follows the project directory, not the parser's own guess", () => {
    // The dirName is known before a byte is read, so it wins.
    mocks.session = makeSession("claude")
    mocks.dirName = "codex__L3RtcC9wcm9qZWN0"

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("claude-raw-count")).toHaveTextContent("0")
  })
})
