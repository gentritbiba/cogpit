import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { AccountSection } from "@/components/ConfigDialog/AccountSection"

const ACCOUNTS = [
  {
    slot: 1,
    alias: "work",
    email: "work@example.com",
    organization: "Work Org",
    active: false,
    disabled: false,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 50, resetsIn: "33m", resetsAt: null },
      sevenDay: { pct: 79, resetsIn: "4d 7h", resetsAt: null },
    },
  },
  {
    slot: 2,
    alias: null,
    email: "me@example.com",
    organization: null,
    active: true,
    disabled: false,
    usageStatus: "ok",
    usage: null,
  },
  {
    slot: 3,
    alias: "spare",
    email: "spare@example.com",
    organization: null,
    active: false,
    disabled: true,
    usageStatus: "token_expired",
    usage: null,
  },
]

const REPORT = { status: "ok", tool: "claude-swap", version: "0.26.0", activeSlot: 2, accounts: ACCOUNTS }

type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> }

function respond(list: () => Reply, switchReply?: () => Reply | Promise<Reply>) {
  mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/agent-accounts/claude/switch" && init?.method === "POST") {
      return Promise.resolve(switchReply ? switchReply() : { ok: true, json: async () => ({}) })
    }
    if (url === "/api/agent-accounts/claude") return Promise.resolve(list())
    throw new Error(`Unexpected request: ${url}`)
  })
}

const okList = (report: unknown = REPORT) => (): Reply => ({ ok: true, status: 200, json: async () => report })

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Claude Code accounts/ }))
}

describe("AccountSection", () => {
  beforeEach(() => { mocks.authFetch.mockReset() })

  it("renders nothing while loading or when the switcher is missing", async () => {
    let resolveList: (reply: Reply) => void = () => {}
    mocks.authFetch.mockReturnValue(new Promise<Reply>((resolve) => { resolveList = resolve }))
    const { container } = render(<AccountSection kind="claude" disabled={false} />)
    expect(container).toBeEmptyDOMElement()

    resolveList({ ok: true, status: 200, json: async () => ({ status: "missing" }) })
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/agent-accounts/claude"))
    expect(container).toBeEmptyDOMElement()
  })

  it("stays hidden when the server has no switcher for the agent", async () => {
    mocks.authFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "none" }) })
    const { container } = render(<AccountSection kind="claude" disabled={false} />)
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("summarises the active login and lists every account's identity and usage", async () => {
    const user = userEvent.setup()
    respond(okList())
    render(<AccountSection kind="claude" disabled={false} />)

    const trigger = await screen.findByRole("button", { name: /Claude Code accounts/ })
    expect(trigger).toHaveTextContent("me@example.com · 3 accounts")
    await expand(user)

    expect(screen.getByText(/Logins managed by claude-swap 0\.26\.0/)).toBeInTheDocument()
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(screen.getByText("work@example.com")).toBeInTheDocument()
    expect(screen.getByText("Work Org")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("79%")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Disabled")).toBeInTheDocument()
    expect(screen.getByText("Token expired")).toBeInTheDocument()
    // The live account has no switch button; the others do.
    expect(screen.queryByRole("button", { name: "Switch to me@example.com" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Switch to work" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Switch to spare" })).toBeEnabled()
  })

  it("hides switch buttons in the read-only view", async () => {
    const user = userEvent.setup()
    respond(okList())
    render(<AccountSection kind="claude" disabled />)
    await expand(user)
    expect(screen.getByText("work")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument()
  })

  it("switches, blocks duplicate clicks meanwhile, then refreshes and explains the delay", async () => {
    const user = userEvent.setup()
    let finishSwitch: (reply: Reply) => void = () => {}
    const switched = { ...REPORT, activeSlot: 1, accounts: ACCOUNTS.map((a) => ({ ...a, active: a.slot === 1 })) }
    let current: unknown = REPORT
    respond(
      () => ({ ok: true, status: 200, json: async () => current }),
      () => new Promise<Reply>((resolve) => { finishSwitch = resolve }),
    )
    render(<AccountSection kind="claude" disabled={false} />)
    await expand(user)

    await user.click(screen.getByRole("button", { name: "Switch to work" }))

    expect(screen.getByRole("button", { name: "Switch to work" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Switch to work" })).toHaveTextContent("Switching…")
    expect(screen.getByRole("button", { name: "Switch to spare" })).toBeDisabled()
    const call = mocks.authFetch.mock.calls.find(([url]) => url === "/api/agent-accounts/claude/switch")
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ slot: 1 })

    current = switched
    finishSwitch({
      ok: true,
      json: async () => ({
        switched: true,
        message: "Switched to Account-1 (work@example.com)",
        warnings: [],
        credentialStore: "keychain",
      }),
    })

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Switched to Account-1/))
    expect(screen.getByRole("status")).toHaveTextContent(/within about 30 seconds/)
    // The refreshed list now marks slot 1 live and offers a switch back.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Switch to work" })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Switch to me@example.com" })).toBeEnabled()
    expect(screen.getByRole("button", { name: /Claude Code accounts/ })).toHaveTextContent("work · 3 accounts")
  })

  it("reports a failed switch and re-enables the buttons", async () => {
    const user = userEvent.setup()
    respond(okList(), () => ({ ok: false, status: 500, json: async () => ({ error: "Account 1 not found" }) }))
    render(<AccountSection kind="claude" disabled={false} />)
    await expand(user)

    await user.click(screen.getByRole("button", { name: "Switch to work" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Switch failed: Account 1 not found"))
    expect(screen.getByRole("button", { name: "Switch to work" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Switch to spare" })).toBeEnabled()
  })

  it("shows the switcher's own error when it is installed but cannot list", async () => {
    const user = userEvent.setup()
    respond(okList({ status: "error", error: "No accounts are managed yet" }))
    render(<AccountSection kind="claude" disabled={false} />)

    expect(await screen.findByRole("button", { name: /Claude Code accounts/ })).toHaveTextContent("Unavailable")
    await expand(user)
    expect(screen.getByRole("alert")).toHaveTextContent("No accounts are managed yet")
  })
})
