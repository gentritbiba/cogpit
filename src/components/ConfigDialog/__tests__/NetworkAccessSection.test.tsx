import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NetworkAccessSection } from "../NetworkAccessSection"
import type { HostShare } from "@/hooks/useShare"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

/** Minimal stand-in for the parts of Response the share hook reads. */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

function makeShare(overrides: Partial<HostShare> = {}): HostShare {
  return {
    sessionId: "s1",
    dirName: "-tmp-project",
    fileName: "s1.jsonl",
    title: "Refactor the parser",
    createdAt: Date.now() - 2 * 60 * 60 * 1000,
    lastAccessAt: 0,
    guests: 0,
    ...overrides,
  }
}

const server = { shares: [] as HostShare[] }

function renderSection(networkAccess = true) {
  const setNetworkAccess = vi.fn()
  render(
    <NetworkAccessSection
      networkAccess={networkAccess}
      setNetworkAccess={setNetworkAccess}
      networkPassword=""
      setNetworkPassword={vi.fn()}
      showNetworkPassword={false}
      setShowNetworkPassword={vi.fn()}
      hasExistingPassword={false}
      initialNetworkAccess={networkAccess}
      connectedDevices={[]}
      minPasswordLength={12}
    />,
  )
  return { setNetworkAccess }
}

describe("NetworkAccessSection", () => {
  beforeEach(() => {
    server.shares = []
    mocks.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (url === "/api/shares" && method === "GET") return jsonResponse(200, server.shares)
      const revoked = url.match(/^\/api\/shares\/([^/]+)$/)
      if (method === "DELETE" && revoked) {
        server.shares = server.shares.filter((s) => s.sessionId !== revoked[1])
        return jsonResponse(200, { ok: true })
      }
      return jsonResponse(404, { error: "not found" })
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("explains the HTTPS browser boundary when network access is enabled", () => {
    renderSection()

    expect(screen.getByText(/remote browsers need an HTTPS reverse proxy/i)).toBeInTheDocument()
    expect(screen.getByText(/port 19384 remains available to Cogpit hubs/i)).toBeInTheDocument()
  })

  it("delegates switch changes to the settings owner", async () => {
    const user = userEvent.setup()
    const { setNetworkAccess } = renderSection()

    await user.click(screen.getByRole("switch", { name: "Network Access" }))

    expect(setNetworkAccess).toHaveBeenCalledWith(false)
  })

  it("says in one line that nothing is shared", async () => {
    renderSection()

    expect(await screen.findByText("No sessions are shared.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke all" })).not.toBeInTheDocument()
  })

  it("lists a shared session with when it was shared and how many guests are on it", async () => {
    server.shares = [makeShare({ guests: 2, lastAccessAt: Date.now() - 60_000 })]
    renderSection()

    expect(await screen.findByText("Refactor the parser")).toBeInTheDocument()
    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
    expect(screen.getByText(/2 guests/)).toBeInTheDocument()
  })

  it("says a share was never opened rather than dating it to 1970", async () => {
    server.shares = [makeShare({ lastAccessAt: 0 })]
    renderSection()

    expect(await screen.findByText(/never opened/i)).toBeInTheDocument()
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
  })

  it("revokes a single share and drops its row", async () => {
    const user = userEvent.setup()
    server.shares = [makeShare(), makeShare({ sessionId: "s2", title: "Second session" })]
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Revoke share of Refactor the parser" }))

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/shares/s1", { method: "DELETE" })
    await vi.waitFor(() => expect(screen.queryByText("Refactor the parser")).not.toBeInTheDocument())
    expect(screen.getByText("Second session")).toBeInTheDocument()
  })

  it("revokes every share at once", async () => {
    const user = userEvent.setup()
    server.shares = [makeShare(), makeShare({ sessionId: "s2", title: "Second session" })]
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Revoke all" }))

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/shares/s1", { method: "DELETE" })
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/shares/s2", { method: "DELETE" })
    expect(await screen.findByText("No sessions are shared.")).toBeInTheDocument()
  })

  it("falls back to the session id when a share has no title", async () => {
    server.shares = [makeShare({ title: "" })]
    renderSection()

    expect(await screen.findByText("s1")).toBeInTheDocument()
  })
})
