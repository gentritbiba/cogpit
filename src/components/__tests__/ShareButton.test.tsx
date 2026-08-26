import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ShareButton } from "@/components/ShareButton"
import type { HostShare } from "@/hooks/useShare"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  copyToClipboard: vi.fn(),
  networkAccessDisabled: false,
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: { networkAccessDisabled: mocks.networkAccessDisabled } }),
}))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: mocks.copyToClipboard,
}))

const MINTED = "copper-lantern-drift-92"
const ROTATED = "amber-willow-north-41"

function makeShare(overrides: Partial<HostShare> = {}): HostShare {
  return {
    sessionId: "s1",
    dirName: "-tmp-project",
    fileName: "s1.jsonl",
    title: "Refactor the parser",
    createdAt: Date.now() - 60_000,
    lastAccessAt: 0,
    guests: 0,
    ...overrides,
  }
}

/** Minimal stand-in for the parts of Response the share hook reads. */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

const server = { shares: [] as HostShare[], refusesToShare: false }

function shareUrl(): string {
  return `${window.location.origin}/shared/s1`
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const trigger =
    screen.queryByRole("button", { name: "Share session" }) ??
    screen.getByRole("button", { name: "Session is shared" })
  await user.click(trigger)
}

async function enableSharing(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Enable sharing" }))
  await screen.findByText(MINTED)
}

describe("ShareButton", () => {
  beforeEach(() => {
    server.shares = []
    server.refusesToShare = false
    mocks.networkAccessDisabled = false
    mocks.copyToClipboard.mockResolvedValue(true)
    mocks.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (url === "/api/shares" && method === "GET") return jsonResponse(200, server.shares)
      if (url === "/api/shares" && method === "POST") {
        if (server.refusesToShare) {
          return jsonResponse(409, { error: "Turn on network access before sharing a session" })
        }
        const share = makeShare()
        server.shares = [share]
        return jsonResponse(200, { url: "/shared/s1", passphrase: MINTED, share })
      }
      if (url === "/api/shares/s1/regenerate" && method === "POST") {
        return jsonResponse(200, { passphrase: ROTATED })
      }
      if (url === "/api/shares/s1" && method === "DELETE") {
        server.shares = []
        return jsonResponse(200, { ok: true })
      }
      return jsonResponse(404, { error: "not found" })
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("enables sharing from the off state and shows the passphrase once", async () => {
    const user = userEvent.setup()
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    expect(await screen.findByText(/join this session/i)).toBeInTheDocument()

    await enableSharing(user)

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/shares", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "s1" }),
    }))
    expect(screen.getByText(shareUrl())).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Session is shared" })).toBeInTheDocument()
  })

  it("masks the passphrase on any later open and offers a regenerate", async () => {
    const user = userEvent.setup()
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    await enableSharing(user)
    await user.keyboard("{Escape}")
    await openPopover(user)

    expect(await screen.findByText("••••")).toBeInTheDocument()
    expect(screen.queryByText(MINTED)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Regenerate passphrase" }))

    expect(await screen.findByText(ROTATED)).toBeInTheDocument()
    expect(screen.queryByText("••••")).not.toBeInTheDocument()
  })

  it("returns to the off state after stop sharing", async () => {
    const user = userEvent.setup()
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    await enableSharing(user)
    await user.click(screen.getByRole("button", { name: "Stop sharing" }))

    expect(await screen.findByRole("button", { name: "Enable sharing" })).toBeInTheDocument()
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/shares/s1", { method: "DELETE" })
    expect(screen.getByRole("button", { name: "Share session" })).toBeInTheDocument()
  })

  it("copies the link and the passphrase together", async () => {
    const user = userEvent.setup()
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    await enableSharing(user)
    await user.click(screen.getByRole("button", { name: /Copy link & passphrase/ }))

    const copied = mocks.copyToClipboard.mock.calls.at(-1)?.[0] as string
    expect(copied).toContain(shareUrl())
    expect(copied).toContain(MINTED)
  })

  it("notes that the link is local-only while network access is off", async () => {
    const user = userEvent.setup()
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    await screen.findByRole("button", { name: "Enable sharing" })
    expect(screen.queryByText(/only works on this machine/i)).not.toBeInTheDocument()

    await user.keyboard("{Escape}")
    cleanup()
    mocks.networkAccessDisabled = true
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    expect(await screen.findByText(/only works on this machine/i)).toBeInTheDocument()
  })

  it("surfaces the server's refusal inline when sharing is not allowed", async () => {
    const user = userEvent.setup()
    server.refusesToShare = true
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)
    await user.click(await screen.findByRole("button", { name: "Enable sharing" }))

    expect(await screen.findByText("Turn on network access before sharing a session")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Enable sharing" })).toBeInTheDocument()
  })

  it("reports how many guests are connected", async () => {
    const user = userEvent.setup()
    server.shares = [makeShare({ guests: 2 })]
    render(<ShareButton sessionId="s1" />)

    await openPopover(user)

    expect(await screen.findByText(/2 guests connected/i)).toBeInTheDocument()
  })
})
