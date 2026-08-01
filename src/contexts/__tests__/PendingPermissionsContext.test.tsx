import type { ReactNode } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  respondToPermission: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/permissionApi", () => ({
  respondToPermission: mocks.respondToPermission,
  respondToAllPermissions: vi.fn(),
}))

import {
  PendingPermissionsProvider,
  usePendingPermissions,
} from "../PendingPermissionsContext"

function textResponse(body: unknown): Response {
  return {
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response
}

function Probe() {
  const { bySession, awaiting, responding, respond } = usePendingPermissions()
  const first = [...bySession.values()][0]?.[0]
  return (
    <div>
      <span data-testid="awaiting">{[...awaiting].sort().join(",")}</span>
      <span data-testid="summary">{first?.summary ?? ""}</span>
      <span data-testid="responding">{[...responding].join(",")}</span>
      <button type="button" onClick={() => first && respond(first.sessionId, first.requestId, "allow")}>
        allow
      </button>
    </div>
  )
}

function renderProbe(ui: ReactNode = <Probe />) {
  return render(<PendingPermissionsProvider>{ui}</PendingPermissionsProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authFetch.mockResolvedValue(textResponse({ bySession: {} }))
  mocks.respondToPermission.mockResolvedValue(true)
})

afterEach(cleanup)

describe("PendingPermissionsProvider", () => {
  it("groups requests by session and renders a tool summary for each", async () => {
    mocks.authFetch.mockResolvedValue(textResponse({
      bySession: {
        "sess-a": [{ requestId: "r1", toolName: "Bash", input: { command: "rm -rf dist" }, timestamp: 1 }],
        "sess-b": [{ requestId: "r2", toolName: "Write", input: { file_path: "/tmp/x" }, timestamp: 2 }],
      },
    }))

    renderProbe()

    await waitFor(() => {
      expect(screen.getByTestId("awaiting").textContent).toBe("sess-a,sess-b")
    })
    expect(screen.getByTestId("summary").textContent).toBe("rm -rf dist")
  })

  it("tolerates a failed poll instead of dropping a request the user must answer", async () => {
    mocks.authFetch.mockResolvedValue(textResponse({
      bySession: { "sess-a": [{ requestId: "r1", toolName: "Bash", input: {}, timestamp: 1 }] },
    }))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("awaiting").textContent).toBe("sess-a"))

    mocks.authFetch.mockRejectedValue(new Error("offline"))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByTestId("awaiting").textContent).toBe("sess-a")
  })

  it("drops a request locally as soon as it is answered", async () => {
    mocks.authFetch.mockResolvedValue(textResponse({
      bySession: { "sess-a": [{ requestId: "r1", toolName: "Bash", input: {}, timestamp: 1 }] },
    }))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("awaiting").textContent).toBe("sess-a"))

    // The refetch after responding must not resurrect it.
    mocks.authFetch.mockResolvedValue(textResponse({ bySession: {} }))
    await act(async () => { screen.getByRole("button", { name: "allow" }).click() })

    await waitFor(() => expect(screen.getByTestId("awaiting").textContent).toBe(""))
    expect(mocks.respondToPermission).toHaveBeenCalledWith("sess-a", "r1", "allow")
  })

  it("keeps the request when the server rejects the answer", async () => {
    mocks.authFetch.mockResolvedValue(textResponse({
      bySession: { "sess-a": [{ requestId: "r1", toolName: "Bash", input: {}, timestamp: 1 }] },
    }))
    mocks.respondToPermission.mockResolvedValue(false)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("awaiting").textContent).toBe("sess-a"))

    await act(async () => { screen.getByRole("button", { name: "allow" }).click() })

    expect(screen.getByTestId("awaiting").textContent).toBe("sess-a")
  })

  it("throws a clear error when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/PendingPermissionsProvider/)
    spy.mockRestore()
  })
})
