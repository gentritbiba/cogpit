import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { PermissionRequest } from "@/hooks/usePermissionRequests"
import type { PendingInteraction } from "../../../shared/session/parser"

const mocks = vi.hoisted(() => ({
  pendingInteraction: null as PendingInteraction,
  permissionRequests: [] as PermissionRequest[],
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: { sessionId: "sess-1" },
    pendingInteraction: mocks.pendingInteraction,
    permissionRequests: mocks.permissionRequests,
  }),
}))

import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { accessReadOnlyReason, SessionReadOnlyNotice } from "../SessionReadOnlyNotice"

const REQUEST: PermissionRequest = {
  requestId: "approval-1",
  toolName: "Bash",
  input: { command: "rm -rf build" },
  toolUseId: "tool-1",
  timestamp: 1,
}

afterEach(() => {
  cleanup()
  __resetEditionUiForTest()
  mocks.pendingInteraction = null
  mocks.permissionRequests = []
})

describe("SessionReadOnlyNotice", () => {
  it("says view only for a session the user can only read", () => {
    render(<SessionReadOnlyNotice reason={{ kind: "view-only" }} />)

    expect(screen.getByRole("status")).toHaveTextContent("View only")
  })

  it("lets the edition's note stand for view only, for the open session", () => {
    __installEditionUiForTest({ ReadOnlyNote: ({ sessionId }) => `Read-only copy of ${sessionId}` })
    render(<SessionReadOnlyNotice reason={{ kind: "view-only" }} />)

    expect(screen.getByRole("status")).toHaveTextContent("Read-only copy of sess-1")
  })

  it("keeps pending prompts visible to a viewer without the controls to answer them", () => {
    mocks.pendingInteraction = { type: "plan", summary: "Rewrite the parser", actions: ["interactive"] }
    mocks.permissionRequests = [REQUEST]
    render(<SessionReadOnlyNotice reason={{ kind: "view-only" }} />)

    expect(screen.getByText("Plan ready for review")).toBeInTheDocument()
    expect(screen.getByText("Rewrite the parser")).toBeInTheDocument()
    expect(screen.getByText("rm -rf build")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Reject|Allow|Deny|Implement/ })).not.toBeInTheDocument()
  })

  it("leaves the externally driven notice as it was, without prompts", () => {
    mocks.permissionRequests = [REQUEST]
    render(<SessionReadOnlyNotice reason={{ kind: "external", agentKind: "claude" }} />)

    expect(screen.getByRole("status")).toHaveTextContent("controlled by another process")
    expect(screen.queryByText("rm -rf build")).not.toBeInTheDocument()
  })

  it("holds the composer back while access is checked, still showing what the session waits on", () => {
    mocks.permissionRequests = [REQUEST]
    render(<SessionReadOnlyNotice reason={{ kind: "checking" }} />)

    expect(screen.getByRole("status")).toHaveTextContent("Checking access…")
    expect(screen.getByText("rm -rf build")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Allow|Deny/ })).not.toBeInTheDocument()
  })

  it("says so when the server has no access for the user", () => {
    render(<SessionReadOnlyNotice reason={{ kind: "no-access" }} />)

    expect(screen.getByRole("status")).toHaveTextContent("You don't have access to this session")
  })

  it("marks a sub-agent view read-only", () => {
    render(<SessionReadOnlyNotice reason={{ kind: "subagent" }} />)

    expect(screen.getByText("Viewing sub-agent session (read-only)")).toBeInTheDocument()
  })
})

describe("accessReadOnlyReason", () => {
  it.each([
    ["unknown", { kind: "checking" }],
    ["none", { kind: "no-access" }],
    ["view", { kind: "view-only" }],
    ["interact", null],
    ["own", null],
  ] as const)("reads %s as %j", (level, reason) => {
    expect(accessReadOnlyReason({ level })).toEqual(reason)
  })
})
