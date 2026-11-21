import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computeSessionDigest, type SessionView } from "../../../shared/session/sessionDigest"
import { cleanup, render, screen } from "@testing-library/react"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"

const mocks = vi.hoisted(() => ({
  session: null as SessionView | null,
  dirName: null as string | null,
  isLive: false,
  stopSession: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ isMobile: true }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionControls: () => ({
    sessionSource: mocks.dirName === null
      ? null
      : { dirName: mocks.dirName, fileName: "s.jsonl", watchOffset: 0, loadId: 1 },
    isLive: mocks.isLive,
    permissions: permissionsForAccess("own"),
    actions: { handleStopSession: mocks.stopSession },
  }),
  useSessionChatContextOptional: () => null,
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.dirName === null
      ? null
      : { dirName: mocks.dirName, fileName: "s.jsonl", watchOffset: 0, loadId: 1 },
    isLive: mocks.isLive,
    permissions: permissionsForAccess("own"),
    actions: { handleStopSession: mocks.stopSession },
  }),
}))

vi.mock("@/components/SessionInfoBar.mobile", () => ({
  MobileSessionInfoBar: ({ contextUsage, onStopSession }: { contextUsage: unknown; onStopSession?: () => void }) => (
    <>
      <div data-testid="context-usage">{contextUsage ? "shown" : "none"}</div>
      {onStopSession && <button type="button" onClick={onStopSession}>Stop session</button>}
    </>
  ),
}))

import { SessionInfoBar } from "../SessionInfoBar"

function makeSession(agentKind: SessionView["agentKind"]): SessionView {
  return {
    agentKind,
    digest: computeSessionDigest([{ type: "assistant" }]),
  } as SessionView
}

beforeEach(() => {
  mocks.session = null
  mocks.dirName = null
  mocks.isLive = false
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SessionInfoBar", () => {
  it("passes context usage to the badge for an agent that tracks context", () => {
    mocks.session = makeSession("claude")
    mocks.dirName = "-Users-me-proj"

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("context-usage")).toHaveTextContent("shown")
  })

  it.each([
    ["codex", "codex__L3RtcC9wcm9qZWN0"],
    ["copilot", "copilot__L3RtcC9wcm9qZWN0"],
  ] as const)("withholds records for %s, which reports no context window", (agentKind, dirName) => {
    mocks.session = makeSession(agentKind)
    mocks.dirName = dirName

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("context-usage")).toHaveTextContent("none")
  })

  it("follows the project directory, not the parser's own guess", () => {
    // The dirName is known before a byte is read, so it wins.
    mocks.session = makeSession("claude")
    mocks.dirName = "codex__L3RtcC9wcm9qZWN0"

    render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)

    expect(screen.getByTestId("context-usage")).toHaveTextContent("none")
  })

  it("hands the mobile menu the same Stop session the desktop title menu uses, only while the session runs", () => {
    mocks.session = makeSession("claude")
    mocks.dirName = "-tmp-project"
    const { rerender } = render(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Stop session" })).not.toBeInTheDocument()

    mocks.isLive = true
    rerender(<SessionInfoBar creatingSession={false} onNewSession={vi.fn()} />)
    screen.getByRole("button", { name: "Stop session" }).click()
    expect(mocks.stopSession).toHaveBeenCalledOnce()
  })
})
