import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryItem, LibraryResponse } from "../../../../shared/library/types"
import type { StoredViewVersion, ViewSummary } from "../../../../shared/views/stored"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  revealSessionById: vi.fn(),
  revealSessionPath: vi.fn(),
  findSessionLocation: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  openFile: vi.fn(),
  windowOpen: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  authUrl: (path: string) => path,
  jsonFetch: (input: string, body: unknown, init: RequestInit = {}) => mocks.authFetch(input, { method: "POST", ...init, body: JSON.stringify(body) }),
}))
vi.mock("@/lib/revealSession", () => ({
  revealSessionById: mocks.revealSessionById,
  revealSessionPath: mocks.revealSessionPath,
  findSessionLocation: mocks.findSessionLocation,
  sessionPath: (dirName: string, fileName: string) => `/${dirName}/${fileName}`,
}))
vi.mock("@/lib/fileOpener", () => ({ openFile: mocks.openFile }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/components/timeline/MarkdownCodeBlock", () => ({
  HighlightedCodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { LibraryPanel } from "../LibraryPanel"
import { ViewPanelProvider } from "@/components/views/ViewPanelContext"
import type { WorkspacePanelContext } from "@/plugin-api"

const SUMMARY: ViewSummary = {
  id: "sales-funnel",
  title: "Sales funnel",
  project: "/Users/me/code/shop",
  sessionId: "session-1",
  latestVersion: 3,
  updatedAt: new Date().toISOString(),
  pinned: false,
}
const OTHER_VIEW: ViewSummary = { ...SUMMARY, id: "other-map", title: "Other map", project: "/Users/me/code/blog", sessionId: "session-9" }

function version(n: number): StoredViewVersion {
  return {
    id: "sales-funnel", title: "Sales funnel", version: n, latestVersion: 3,
    html: `<html><head></head><body>v${n}</body></html>`,
    files: [{ path: "App.tsx", text: `export default () => <p>v${n}</p>` }],
  }
}

function item(overrides: Partial<LibraryItem>): LibraryItem {
  return {
    id: 1, kind: "link", target: "https://example.com/docs", label: null, sessionId: "session-1", turnId: "turn-4", turn: 4,
    sharedAt: new Date().toISOString(), project: "/Users/me/code/shop", keptPath: null, keepState: null, present: true, mentions: 1,
    ...overrides,
  }
}

const ITEMS: Record<string, LibraryItem[]> = {
  media: [
    item({ id: 10, kind: "image", target: "/tmp/shot.png", label: "Checkout page", keptPath: "/lib/files/abc.png", keepState: "kept", present: false }),
    item({ id: 11, kind: "video", target: "/tmp/run.webm", label: "Test run" }),
  ],
  link: [item({ id: 20, target: "https://github.com/o/r/pull/7", label: "PR #7", mentions: 3 })],
  file: [item({ id: 30, kind: "file", target: "/tmp/report.pdf", label: "Q3 report", keptPath: "/lib/files/def.pdf", keepState: "kept", present: false })],
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

function libraryAnswer(url: URL): LibraryResponse {
  const tab = url.searchParams.get("tab")
  const text = url.searchParams.get("q")?.toLowerCase()
  const items = (tab ? ITEMS[tab] ?? [] : []).filter((entry) => !text || (entry.label ?? entry.target).toLowerCase().includes(text))
  return {
    available: true, pendingFiles: 0, counts: { media: 2, link: 1, file: 1 }, items, next: null,
    viewIds: url.searchParams.get("scope") === "session" ? ["other-map"] : [],
    sessions: { "session-1": { title: "Checkout work", cwd: "/Users/me/code/shop" } },
  }
}

let removed: string[] = []

beforeEach(() => {
  localStorage.clear()
  removed = []
  vi.spyOn(window, "open").mockImplementation(mocks.windowOpen)
  mocks.authFetch.mockImplementation((url: string, init: RequestInit = {}) => {
    if (url === "/api/views") return json({ views: [SUMMARY, OTHER_VIEW] })
    if (url.startsWith("/api/library/items/") && init.method === "DELETE") {
      removed.push(url)
      return json({ removed: 1 })
    }
    if (url.startsWith("/api/library?")) return json(libraryAnswer(new URL(url, "http://localhost")))
    const match = /^\/api\/views\/sales-funnel\/v\/(\d+)$/.exec(url)
    if (match) return Number(match[1]) <= 3 ? json(version(Number(match[1]))) : json({ error: "No such view on this computer" }, 404)
    return json({ error: "unexpected" }, 500)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const CONTEXT: WorkspacePanelContext = {
  sessionId: "session-1", sessionChangeKey: 0, projectPath: "/Users/me/code/shop", hasFileChanges: false, canAccessHostFiles: true, canUseBrowser: true,
}

function renderPanel(context: Partial<WorkspacePanelContext> = {}) {
  const closePanel = vi.fn()
  render(
    <ViewPanelProvider shown onReveal={vi.fn()}>
      <LibraryPanel context={{ ...CONTEXT, ...context }} active closePanel={closePanel} />
    </ViewPanelProvider>,
  )
  return closePanel
}

const libraryRequests = () => mocks.authFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/library?"))

async function showTab(name: RegExp) {
  await userEvent.click(screen.getByRole("tab", { name }))
}

/** Opens Sales funnel from the Views tab, as a click on its row would. */
async function openSalesFunnel() {
  renderPanel({ sessionId: null, projectPath: null })
  await showTab(/Views/)
  await userEvent.click((await screen.findByText("Sales funnel")).closest("button")!)
  await screen.findByRole("heading", { name: "Sales funnel" })
}

describe("LibraryPanel", () => {
  it("opens on the session's media, with a count on every tab", async () => {
    const closePanel = renderPanel()
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument()
    const media = await screen.findByTestId("library-media")
    expect(within(media).getByRole("button", { name: "Open Checkout page" })).toBeInTheDocument()
    expect(within(media).getByText("Saved copy")).toBeInTheDocument()
    expect(media.querySelector("img")).toHaveAttribute("src", "/api/local-file?path=%2Flib%2Ffiles%2Fabc.png")
    expect(libraryRequests()[0]).toBe("/api/library?scope=session&tab=media&session=session-1&limit=60")
    await waitFor(() => expect(screen.getByRole("tab", { name: /Views/ })).toHaveTextContent("Views2"))
    expect(screen.getByRole("tab", { name: /Links/ })).toHaveTextContent("Links1")
    await userEvent.click(screen.getByRole("button", { name: "Close library" }))
    expect(closePanel).toHaveBeenCalled()
  })

  it("switches scope and remembers it, falling back where no session is open", async () => {
    renderPanel()
    await screen.findByTestId("library-media")
    await userEvent.click(screen.getByRole("button", { name: "All", pressed: false }))
    await waitFor(() => expect(libraryRequests().at(-1)).toBe("/api/library?scope=all&tab=media&limit=60"))
    cleanup()

    renderPanel({ sessionId: null })
    await screen.findByTestId("library-media")
    expect(libraryRequests().at(-1)).toBe("/api/library?scope=all&tab=media&limit=60")
    localStorage.clear()
    cleanup()
    renderPanel({ sessionId: null })
    await screen.findByTestId("library-media")
    expect(libraryRequests().at(-1)).toBe("/api/library?scope=project&tab=media&project=%2FUsers%2Fme%2Fcode%2Fshop&limit=60")
    expect(screen.getByRole("button", { name: "Session", pressed: false })).toBeDisabled()
  })

  it("lists links with where they came from, and opens one in the browser", async () => {
    renderPanel()
    await showTab(/Links/)
    const links = await screen.findByTestId("library-links")
    expect(within(links).getByText("PR #7")).toBeInTheDocument()
    expect(within(links).getByText("github.com/o/r/pull/7")).toBeInTheDocument()
    expect(within(links).getByTitle("Shared 3 times")).toBeInTheDocument()
    await userEvent.click(within(links).getByText("PR #7"))
    expect(mocks.windowOpen).toHaveBeenCalledWith("https://github.com/o/r/pull/7", "_blank", "noopener,noreferrer")
  })

  it("opens a file whose original is gone from the library's copy", async () => {
    renderPanel()
    await showTab(/Files/)
    const files = await screen.findByTestId("library-files")
    expect(within(files).getByText("Saved copy · the original is gone")).toBeInTheDocument()
    await userEvent.click(within(files).getByText("Q3 report"))
    expect(mocks.openFile).toHaveBeenCalledWith("/lib/files/def.pdf")
  })

  it("filters the tab through the server", async () => {
    renderPanel()
    await showTab(/Links/)
    await screen.findByTestId("library-links")
    await userEvent.type(screen.getByRole("textbox", { name: "Filter the library" }), "nothing")
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument()
    expect(libraryRequests().at(-1)).toContain("q=nothing")
  })

  it("goes to the message that shared an item", async () => {
    mocks.findSessionLocation.mockResolvedValue({ dirName: "-shop", fileName: "session-1.jsonl" })
    renderPanel()
    await showTab(/Links/)
    await screen.findByTestId("library-links")
    await userEvent.click(screen.getByRole("button", { name: "Actions for PR #7" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Go to message" }))
    await waitFor(() => expect(mocks.revealSessionPath).toHaveBeenCalledWith("/-shop/session-1.jsonl"))
    expect(mocks.findSessionLocation).toHaveBeenCalledWith("session-1")
  })

  it("removes an item only after confirming", async () => {
    renderPanel()
    await showTab(/Links/)
    await screen.findByTestId("library-links")
    await userEvent.click(screen.getByRole("button", { name: "Actions for PR #7" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from library" }))
    expect(removed).toEqual([])
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }))
    await waitFor(() => expect(removed).toEqual(["/api/library/items/20"]))
  })

  it("lists the views the session made or showed", async () => {
    renderPanel()
    await showTab(/Views/)
    expect(await screen.findByText("Sales funnel")).toBeInTheDocument()
    expect(await screen.findByText("Other map")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Project", pressed: false }))
    await waitFor(() => expect(screen.queryByText("Other map")).not.toBeInTheDocument())
    expect(screen.getByText("Sales funnel")).toBeInTheDocument()
  })

  it("shows an opened view's version in the sandboxed frame", async () => {
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
    await openSalesFunnel()
    await userEvent.click(await screen.findByRole("button", { name: "Open session" }))
    expect(mocks.revealSessionById).toHaveBeenCalledWith("session-1")
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("The session that made this view is not on this computer"))
  })

  it("goes back to the library", async () => {
    await openSalesFunnel()
    await act(() => userEvent.click(screen.getByRole("button", { name: "Back to the library" })))
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument()
  })
})
