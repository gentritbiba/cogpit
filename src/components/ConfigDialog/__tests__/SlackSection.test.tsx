import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { SlackSection } from "@/components/ConfigDialog/SlackSection"
import type { SlackLinksReport } from "../../../../shared/contracts/slack"

const LINK: SlackLinksReport["links"][number] = {
  sessionId: "e59cd71c-4f77-4fac-bb70-51ce10718d50",
  title: "HonestCMS PM",
  bot: "odyssey",
  allow: ["U01TRP22K28"],
  dms: ["D0BK06FJKHD"],
  channels: [],
  autoPost: false,
  dailyCap: 20,
  createdAt: 1,
  connection: { state: "connected", connectedAt: "2026-10-28T13:46:16.787Z" },
  pending: [],
  awaitingTurn: 0,
  uncertain: [],
  postedToday: 3,
  recentlyIgnored: [],
}

const report = (overrides: Partial<SlackLinksReport> = {}): SlackLinksReport => ({
  available: true,
  bots: [{ name: "odyssey", botUserId: "U0BK06BR2AK", teamId: "T1", teamName: "Honest Digital", addedAt: 1 }],
  links: [LINK],
  ...overrides,
})

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })

function serve(reports: SlackLinksReport[], post = () => ok({})) {
  let index = 0
  mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== "/api/slack") throw new Error(`Unexpected request: ${url}`)
    if (init?.method === "POST") return post()
    return ok(reports[Math.min(index++, reports.length - 1)])
  })
}

async function openSection() {
  await userEvent.click(await screen.findByRole("button", { name: /slack links/i }))
}

beforeEach(() => {
  mocks.authFetch.mockReset()
})

describe("SlackSection", () => {
  it("summarises the link and shows who it listens to and where it posts", async () => {
    serve([report()])
    render(<SlackSection disabled={false} />)
    expect(await screen.findByText("1 link · Connected")).toBeInTheDocument()
    await openSection()
    expect(screen.getByText("HonestCMS PM")).toBeInTheDocument()
    expect(screen.getByText("Listens to U01TRP22K28 · posts to 1 DM · 3/20 posts today")).toBeInTheDocument()
  })

  it("turns automatic posting on and unlinks through the API", async () => {
    serve([report(), report({ links: [{ ...LINK, autoPost: true }] }), report({ links: [] })])
    render(<SlackSection disabled={false} />)
    await openSection()
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked())
    expect(JSON.parse(mocks.authFetch.mock.calls.find(([, init]) => init?.method === "POST")![1].body)).toEqual({ sessionId: LINK.sessionId, action: "update", autoPost: true })
    await userEvent.click(screen.getByRole("button", { name: /unlink honestcms pm/i }))
    expect(await screen.findByText("Not linked: odyssey (Honest Digital)")).toBeInTheDocument()
  })

  it("shows queued and uncertain messages and connection errors", async () => {
    serve([report({ links: [{ ...LINK, connection: { state: "failed", lastError: "Slack apps.connections.open failed: invalid_auth" }, pending: [{ key: "k", attempts: 2, lastError: "session restarting" }], uncertain: [{ key: "u", commandId: "c" }] }] })])
    render(<SlackSection disabled={false} />)
    expect(await screen.findByText("1 link · Failed")).toBeInTheDocument()
    await openSection()
    expect(screen.getByText("Slack apps.connections.open failed: invalid_auth")).toBeInTheDocument()
    expect(screen.getByText("1 message waiting to reach the session: session restarting")).toBeInTheDocument()
    expect(screen.getByText("1 message may not have arrived; check the session's queue")).toBeInTheDocument()
  })

  it("is read-only without config access, and absent where links are unavailable", async () => {
    serve([report()])
    const { unmount } = render(<SlackSection disabled />)
    await openSection()
    expect(screen.getByRole("switch", { name: /post the session/i })).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: /unlink/i })).not.toBeInTheDocument()
    unmount()
    serve([report({ available: false })])
    const { container } = render(<SlackSection disabled={false} />)
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("reports a refused change", async () => {
    serve([report()], () => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "Session x is not linked to Slack" }) }))
    render(<SlackSection disabled={false} />)
    await openSection()
    await userEvent.click(screen.getByRole("switch"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Session x is not linked to Slack")
  })
})

describe("useSlackLinks ordering", () => {
  it("keeps a saved change when an older refresh answers after it", async () => {
    let releaseStale!: () => void
    const stale = new Promise<void>((resolve) => { releaseStale = resolve })
    let gets = 0
    mocks.authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({}) }
      gets++
      if (gets === 2) {
        await stale
        return { ok: true, status: 200, json: async () => report() }
      }
      return { ok: true, status: 200, json: async () => report({ links: [{ ...LINK, autoPost: gets > 2 }] }) }
    })
    render(<SlackSection disabled={false} />)
    await openSection()
    await userEvent.click(screen.getByRole("button", { name: /refresh slack links/i }))
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked())
    releaseStale()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole("switch")).toBeChecked()
  })
})
