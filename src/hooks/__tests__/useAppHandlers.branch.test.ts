import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), loadSessionTailCached: vi.fn(), toastError: vi.fn() }))
vi.mock("@/contexts/SessionInventoryContext", () => ({ useSessionInventory: () => ({ removeSession: vi.fn() }) }))
vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  jsonFetch: (url: string, body: unknown) => mocks.authFetch(url, { method: "POST", body: JSON.stringify(body) }),
}))
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))
vi.mock("@/lib/sessionLoader", () => ({
  loadSessionTailCached: mocks.loadSessionTailCached,
  loadSessionTailFresh: vi.fn(),
}))

import { useAppHandlers } from "@/hooks/useAppHandlers"
import { ACCESS_LOST_MESSAGE, useSessionAccessLoss } from "@/hooks/useSessionAccessLoss"
import { SESSION_ACCESS_LOST_EVENT } from "@/lib/sessionAccessEvents"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import {
  __resetSessionAccessForTest,
  knownSessionAccess,
  learnListedAccess,
  sessionAccessTicket,
} from "@/lib/sessionAccess"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import type { ParsedSession } from "../../../shared/session/types"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"
import { SESSION_ACCESS_HEADER, SESSION_ID_HEADER } from "../../../shared/contracts/sessionAccess"

const ALICE = { id: "u_alice", username: "alice", displayName: "Alice" }
const COPY = "22222222-2222-4222-8222-222222222222"

function handlerDeps(dispatch: (action: SessionAction) => void): Parameters<typeof useAppHandlers>[0] {
  const parsed = { sessionId: "original", turns: [{ id: "turn-1" }] } as unknown as ParsedSession
  return {
    state: {
      session: parsed,
      sessionSource: { dirName: "-work-app", fileName: "original.jsonl", rawText: "" },
    },
    dispatch,
    isMobile: false,
    handleJumpToTurn: vi.fn(),
    markPermissionsApplied: vi.fn(),
    hasPermsPendingChanges: false,
    permissionsConfig: { mode: "default" } as PermissionsConfig,
    settingsChange: [],
    onSettingsChangeSent: vi.fn(),
    selectedModel: "",
    selectedEffort: "",
    fastMode: false,
    ultracode: false,
    mcpConfig: null,
    scrollRequestScrollToTop: vi.fn(),
    handleDashboardSelect: vi.fn(),
    workerParse: vi.fn(),
    canInteract: false,
  }
}

function renderHandlers(dispatch: (action: SessionAction) => void) {
  return renderHook(() => useAppHandlers(handlerDeps(dispatch)))
}

describe("useAppHandlers copies", () => {
  beforeEach(() => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { ...ALICE },
      capabilities: NO_CAPABILITIES,
      enforcesSessionAccess: true,
    })
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({
      dirName: "-work-app",
      fileName: `${COPY}.jsonl`,
      sessionId: COPY,
    })))
    mocks.loadSessionTailCached.mockResolvedValue({ parsed: { sessionId: COPY }, source: { dirName: "-work-app" } })
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    __resetSessionAccessForTest()
  })

  it.each([
    ["duplicate", (handlers: ReturnType<typeof useAppHandlers>) => handlers.handleDuplicateSessionByPath("-work-app", "original.jsonl")],
    ["branch", (handlers: ReturnType<typeof useAppHandlers>) => handlers.handleBranchFromHere(0)],
  ] as const)("owns the %s it just made before opening it", async (_kind, copy) => {
    const accessWhenOpened = vi.fn()
    const dispatch = (action: SessionAction) => {
      if (action.type === "LOAD_SESSION") accessWhenOpened(knownSessionAccess(COPY))
    }
    const { result } = renderHandlers(dispatch)

    await act(() => copy(result.current))

    expect(accessWhenOpened).toHaveBeenCalledWith("own")
  })
})

describe("useAppHandlers delete", () => {
  beforeEach(() => mocks.toastError.mockReset())

  it.each([
    ["deleted", new Response("{}"), true, null],
    ["refused", new Response(JSON.stringify({ error: "Your access to this session does not allow this" }), { status: 403 }), false, "Your access to this session does not allow this"],
    ["already deleted from another client", new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { [SESSION_ACCESS_HEADER]: "none", [SESSION_ID_HEADER]: "original" },
    }), true, null],
    ["already gone from disk", new Response(JSON.stringify({ error: "Transcript not found" }), { status: 404 }), true, null],
  ] as const)("resolves whether the session was %s, saying why when it was not", async (_outcome, response, deleted, toast) => {
    mocks.authFetch.mockResolvedValueOnce(response)
    const { result } = renderHandlers(vi.fn())

    expect(await result.current.handleDeleteSession("-work-app", "original.jsonl")).toBe(deleted)
    expect(mocks.authFetch).toHaveBeenLastCalledWith("/api/delete-session", expect.objectContaining({
      body: JSON.stringify({ dirName: "-work-app", fileName: "original.jsonl" }),
    }))
    if (toast) expect(mocks.toastError).toHaveBeenCalledWith(toast)
    else expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    ["the session it deleted", "00000000-0000-4000-8000-00000000000d", "", new Response("{}"), null],
    ["the session another client of its owner already deleted", "00000000-0000-4000-8000-00000000000e", "", new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { [SESSION_ACCESS_HEADER]: "none", [SESSION_ID_HEADER]: "00000000-0000-4000-8000-00000000000e" },
    }), null],
    ["a session one of whose sub-agents it deleted", "00000000-0000-4000-8000-00000000000f", "/subagents/agent-a1.jsonl", new Response("{}"), ACCESS_LOST_MESSAGE],
  ] as const)("closes %s, reporting lost access only if the delete did not take it away", async (_case, sessionId, subagent, response, toast) => {
    const leave = vi.fn()
    learnListedAccess([{ sessionId, access: { level: "own", mine: true } }], sessionAccessTicket())
    const lose = () => window.dispatchEvent(new CustomEvent(SESSION_ACCESS_LOST_EVENT, { detail: { sessionId } }))
    mocks.authFetch.mockImplementationOnce(async () => {
      // Once the request is out, the session's stream hears the change before the delete's own answer arrives.
      await Promise.resolve()
      lose()
      return response
    })
    const { result } = renderHook(() => {
      useSessionAccessLoss({ openSessionId: sessionId, leave, forgetVisits: vi.fn() })
      return useAppHandlers(handlerDeps(vi.fn()))
    })

    const fileName = subagent ? `${sessionId}${subagent}` : `${sessionId}.jsonl`
    await act(() => result.current.handleDeleteSession("-work-app", fileName))
    // A reconnect or a request still in flight hears it again.
    await act(async () => lose())

    expect(leave).toHaveBeenCalled()
    if (toast) expect(mocks.toastError).toHaveBeenCalledWith(toast, { id: `session-access-lost:${sessionId}` })
    else expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("keeps the session when the server cannot be reached", async () => {
    mocks.authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const { result } = renderHandlers(vi.fn())

    expect(await result.current.handleDeleteSession("-work-app", "original.jsonl")).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith("Could not delete session")
  })
})
