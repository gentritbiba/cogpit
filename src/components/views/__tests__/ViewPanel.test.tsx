import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredViewVersion, ViewSummary } from "../../../../shared/views/stored"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  revealSessionById: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  authUrl: (path: string) => path,
  jsonFetch: (input: string, body: unknown, init: RequestInit = {}) => mocks.authFetch(input, { method: "POST", ...init, body: JSON.stringify(body) }),
}))
vi.mock("@/lib/revealSession", () => ({ revealSessionById: mocks.revealSessionById }))
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))
vi.mock("@/components/timeline/MarkdownCodeBlock", () => ({
  HighlightedCodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { ViewPanel } from "../ViewPanel"
import { ViewPanelProvider } from "../ViewPanelContext"

const SUMMARY: ViewSummary = {
  id: "sales-funnel",
  title: "Sales funnel",
  project: "/Users/me/code/shop",
  sessionId: "session-1",
  latestVersion: 3,
  updatedAt: new Date().toISOString(),
  pinned: false,
}

function version(n: number): StoredViewVersion {
  return {
    id: "sales-funnel", title: "Sales funnel", version: n, latestVersion: 3,
    html: `<html><head></head><body>v${n}</body></html>`,
    files: [{ path: "App.tsx", text: `export default () => <p>v${n}</p>` }],
  }
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

function renderPanel() {
  const closePanel = vi.fn()
  render(
    <ViewPanelProvider shown onReveal={vi.fn()}>
      <ViewPanel context={{ session: null, sessionChangeKey: 0, projectPath: null, hasFileChanges: false, canAccessHostFiles: true, canUseBrowser: true }} active closePanel={closePanel} />
    </ViewPanelProvider>,
  )
  return closePanel
}

/** Opens Sales funnel from the panel's own list, as a click on a sidebar row would. */
async function openSalesFunnel() {
  await userEvent.click((await screen.findByText("Sales funnel")).closest("button")!)
  await screen.findByRole("heading", { name: "Sales funnel" })
}

beforeEach(() => {
  mocks.authFetch.mockImplementation((url: string) => {
    if (url === "/api/views") return json({ views: [SUMMARY] })
    const match = /^\/api\/views\/sales-funnel\/v\/(\d+)$/.exec(url)
    if (match) return Number(match[1]) <= 3 ? json(version(Number(match[1]))) : json({ error: "No such view on this computer" }, 404)
    return json({ error: "unexpected" }, 500)
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ViewPanel", () => {
  it("lists the views when none is open", async () => {
    const closePanel = renderPanel()
    expect(screen.getByRole("heading", { name: "Views" })).toBeInTheDocument()
    expect(await screen.findByText("Sales funnel")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Close views" }))
    expect(closePanel).toHaveBeenCalled()
  })

  it("shows the opened version in the sandboxed frame", async () => {
    renderPanel()
    await openSalesFunnel()
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/sales-funnel/v/3")
    const frame = await waitFor(() => {
      const found = document.querySelector("iframe")
      if (!found) throw new Error("no frame yet")
      return found
    })
    expect(frame).toHaveAttribute("title", "Sales funnel")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
  })

  it("fetches the version the picker chooses", async () => {
    renderPanel()
    await openSalesFunnel()

    await userEvent.click(screen.getByRole("combobox", { name: "Version" }))
    expect(await screen.findByRole("option", { name: "v3 · latest" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "v2" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: "v1" }))

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/sales-funnel/v/1"))
    expect(screen.getByRole("combobox", { name: "Version" })).toHaveTextContent("v1")

    await userEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(await screen.findByText("App.tsx")).toBeInTheDocument()
    expect(screen.getByText(/<p>v1<\/p>/)).toBeInTheDocument()
  })

  it("opens the session that made the view", async () => {
    mocks.revealSessionById.mockResolvedValue(false)
    renderPanel()
    await openSalesFunnel()

    await userEvent.click(await screen.findByRole("button", { name: "Open session" }))
    expect(mocks.revealSessionById).toHaveBeenCalledWith("session-1")
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("The session that made this view is not on this computer"))
  })

  it("goes back to the list", async () => {
    renderPanel()
    await openSalesFunnel()
    await act(() => userEvent.click(screen.getByRole("button", { name: "All views" })))
    expect(screen.getByRole("heading", { name: "Views" })).toBeInTheDocument()
  })
})
