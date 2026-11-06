import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadViewLibraries: vi.fn(),
  authFetch: vi.fn(),
  composer: null as null | { snapshot: () => unknown; replace: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> },
}))
vi.mock("../view/libraries", () => ({ loadViewLibraries: mocks.loadViewLibraries }))
vi.mock("@/plugins/composerBridge", () => ({ activeComposer: () => mocks.composer }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import CogpitView from "../view/CogpitView"
import { ViewPanelProvider, useViewPanel } from "@/components/views/ViewPanelContext"

const renderCode = (code: string) => <pre>{code}</pre>

const SOURCE = `<title>Sine wave</title><input type="range"><script src="cogpit:lib/d3"></script>`

function frame(): HTMLIFrameElement {
  return screen.getByTitle("Sine wave") as HTMLIFrameElement
}

/** A message as the view's frame, or another window, would post it. */
function post(data: unknown, source: MessageEventSource | null = frame().contentWindow) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data, source })) })
}

beforeEach(() => {
  mocks.loadViewLibraries.mockResolvedValue([{ name: "d3", code: "window.d3 = {}" }])
  mocks.composer = null
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("CogpitView", () => {
  it("waits for the reply to close the block before running it", () => {
    render(<CogpitView source={SOURCE} complete={false} fallback={<pre>source</pre>} renderCode={renderCode} />)
    expect(screen.getByText(/The view appears when the reply finishes/)).toBeInTheDocument()
    expect(screen.queryByTitle("Sine wave")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(screen.getByText("source")).toBeInTheDocument()
  })

  it("runs the view in a sandbox with no origin of its own", () => {
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    expect(screen.getByRole("heading", { name: "Sine wave" })).toBeInTheDocument()
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame().getAttribute("src")).toBe("/api/views/shell/v1")
  })

  it("sends the composed page and its libraries once the sandbox is ready", async () => {
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    const send = vi.spyOn(frame().contentWindow!, "postMessage")
    post({ cogpitView: 1, type: "ready" })
    await waitFor(() => expect(send).toHaveBeenCalled())
    const [message, target] = send.mock.calls[0]!
    expect(target).toBe("*")
    expect(message).toMatchObject({ type: "cogpit-view:render", libraries: [{ name: "d3", code: "window.d3 = {}" }] })
    expect((message as { html: string }).html).toContain(`<body>${SOURCE}</body>`)
    expect(mocks.loadViewLibraries).toHaveBeenCalledWith(new Set(["d3"]))
  })

  it("ignores messages from any other window", async () => {
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    const send = vi.spyOn(frame().contentWindow!, "postMessage")
    post({ cogpitView: 1, type: "ready" }, window)
    await act(() => new Promise((done) => setTimeout(done, 0)))
    expect(send).not.toHaveBeenCalled()
  })

  it("sizes the frame to its page within bounds", () => {
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    post({ cogpitView: 1, type: "resize", height: 412 })
    expect(frame().style.height).toBe("412px")
    post({ cogpitView: 1, type: "resize", height: 90_000 })
    expect(frame().style.height).toBe("1600px")
  })

  it("shows a script error and lets the user ask the agent to fix it", () => {
    const replace = vi.fn(() => ({}))
    mocks.composer = { snapshot: () => ({ token: "t1", draft: { v: 1, text: "Earlier note", context: [], attachments: [] } }), replace, focus: vi.fn() }
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    post({ cogpitView: 1, type: "error", message: "d3 is not defined" })
    expect(screen.getByRole("alert")).toHaveTextContent("d3 is not defined")
    fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }))
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^Earlier note\n\nThe interactive view "Sine wave" shows this error: d3 is not defined/) }), "t1")
  })

  it("acts on links and questions only while the user is inside the view", () => {
    const replace = vi.fn(() => ({}))
    mocks.composer = { snapshot: () => ({ token: "t1", draft: { v: 1, text: "", context: [], attachments: [] } }), replace, focus: vi.fn() }
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(<CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />)
    post({ cogpitView: 1, type: "open", href: "https://example.test/" })
    post({ cogpitView: 1, type: "ask", text: "Explain step 2" })
    expect(open).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()

    frame().focus()
    post({ cogpitView: 1, type: "open", href: "https://example.test/" })
    post({ cogpitView: 1, type: "ask", text: "Explain step 2" })
    expect(open).toHaveBeenCalledWith("https://example.test/", "_blank", "noopener,noreferrer")
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ text: "Explain step 2" }), "t1")
    open.mockRestore()
  })

  describe("stored views", () => {
    const stored = (version: number, latestVersion = version) => ({
      id: "sales-funnel", title: "Sales funnel", version, latestVersion,
      html: `<html><head><script>(kit)("__COGPIT_VIEW_THEME__")</script></head><body>v${version}</body></html>`,
      files: [{ path: "App.tsx", text: `export default function App() { return <p>v${version}</p> }` }],
    })
    const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }))

    it("fetches the version a reply names and posts its page with the viewer's theme", async () => {
      mocks.authFetch.mockImplementation(() => respond(200, stored(3)))
      render(<CogpitView source={"sales-funnel@3\n"} complete fallback={null} renderCode={renderCode} />)
      expect(mocks.authFetch).toHaveBeenCalledWith("/api/views/sales-funnel/v/3")
      await waitFor(() => expect(screen.getByRole("heading", { name: "Sales funnel" })).toBeInTheDocument())
      const send = vi.spyOn(screen.getByTitle("Sales funnel") as HTMLIFrameElement, "contentWindow", "get")
      const target = { postMessage: vi.fn() }
      send.mockReturnValue(target as unknown as Window)
      post({ cogpitView: 1, type: "ready" }, target as unknown as Window)
      await waitFor(() => expect(target.postMessage).toHaveBeenCalled())
      const [message] = target.postMessage.mock.calls[0]!
      expect(message).toMatchObject({ type: "cogpit-view:render", libraries: [] })
      expect((message as { html: string }).html).not.toContain("__COGPIT_VIEW_THEME__")
      expect((message as { html: string }).html).toContain("<body>v3</body>")
      expect(mocks.loadViewLibraries).not.toHaveBeenCalled()
    })

    it("shows the source files and offers a newer version", async () => {
      mocks.authFetch.mockImplementation((url: string) => respond(200, url.endsWith("/v/5") ? stored(5) : stored(3, 5)))
      render(<CogpitView source="sales-funnel@3" complete fallback={null} renderCode={renderCode} />)
      fireEvent.click(await screen.findByRole("button", { name: "v5 available" }))
      expect(mocks.authFetch).toHaveBeenLastCalledWith("/api/views/sales-funnel/v/5")
      expect(await screen.findByRole("button", { name: "Back to v3" })).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Show source" }))
      expect(await screen.findByText("App.tsx")).toBeInTheDocument()
      expect(screen.getByText(/return <p>v5<\/p>/)).toBeInTheDocument()
    })

    it("says so when the view is not on the session's computer", async () => {
      mocks.authFetch.mockImplementation(() => respond(404, { error: "No such view version" }))
      render(<CogpitView source="sales-funnel@3" complete fallback={null} renderCode={renderCode} />)
      expect(await screen.findByRole("alert")).toHaveTextContent("not on the computer that ran this session")
      expect(screen.queryByRole("button", { name: "Reload view" })).not.toBeInTheDocument()
    })

    it("names the view in the fix request", async () => {
      const replace = vi.fn(() => ({}))
      mocks.composer = { snapshot: () => ({ token: "t1", draft: { v: 1, text: "", context: [], attachments: [] } }), replace, focus: vi.fn() }
      mocks.authFetch.mockImplementation(() => respond(200, stored(3)))
      render(<CogpitView source="sales-funnel@3" complete fallback={null} renderCode={renderCode} />)
      const storedFrame = await screen.findByTitle("Sales funnel") as HTMLIFrameElement
      post({ cogpitView: 1, type: "error", message: "boom (App.tsx:4)" }, storedFrame.contentWindow)
      fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }))
      expect(replace).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(`"Sales funnel" (sales-funnel@3) shows this error: boom (App.tsx:4)`) }), "t1")
    })

    it("opens the version it shows in the view panel", async () => {
      mocks.authFetch.mockImplementation((url: string) => respond(200, url.endsWith("/v/5") ? stored(5) : stored(3, 5)))
      const reveal = vi.fn()
      function PanelTarget() {
        const panel = useViewPanel()
        return <output data-testid="panel-target">{panel?.target ? `${panel.target.id}@${panel.target.version}` : "none"}</output>
      }
      render(
        <ViewPanelProvider shown={false} onReveal={reveal}>
          <CogpitView source="sales-funnel@3" complete fallback={null} renderCode={renderCode} />
          <PanelTarget />
        </ViewPanelProvider>,
      )
      fireEvent.click(await screen.findByRole("button", { name: "v5 available" }))
      await screen.findByRole("button", { name: "Back to v3" })
      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }))
      expect(reveal).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("panel-target")).toHaveTextContent("sales-funnel@5")
    })

    it("offers the panel only for stored views, and only where the layout has one", async () => {
      mocks.authFetch.mockImplementation(() => respond(200, stored(3)))
      render(<CogpitView source="sales-funnel@3" complete fallback={null} renderCode={renderCode} />)
      await screen.findByRole("heading", { name: "Sales funnel" })
      expect(screen.queryByRole("button", { name: "Open in panel" })).not.toBeInTheDocument()
      cleanup()

      render(
        <ViewPanelProvider shown={false} onReveal={vi.fn()}>
          <CogpitView source={SOURCE} complete fallback={null} renderCode={renderCode} />
        </ViewPanelProvider>,
      )
      expect(screen.getByRole("heading", { name: "Sine wave" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Open in panel" })).not.toBeInTheDocument()
    })

    it("offers a version built after the card mounted", async () => {
      const page = (version: number, latestVersion: number) => ({ ...stored(version, latestVersion), id: "late-build", title: "Late build" })
      mocks.authFetch.mockImplementation(() => respond(200, page(1, 1)))
      render(<CogpitView source="late-build@1" complete fallback={null} renderCode={renderCode} />)
      await screen.findByTitle("Late build")
      expect(screen.queryByRole("button", { name: /available/ })).not.toBeInTheDocument()

      // The agent's next reply names v2: its card's fetch tells the older card.
      mocks.authFetch.mockImplementation((url: string) => respond(200, url === "/api/views" ? { views: [] } : page(2, 2)))
      render(<CogpitView source="late-build@2" complete fallback={null} renderCode={renderCode} />)
      expect(await screen.findByRole("button", { name: "v2 available" })).toBeInTheDocument()

      // Coming back to the window checks the list for anything newer.
      mocks.authFetch.mockImplementation((url: string) => respond(200, url === "/api/views"
        ? { views: [{ id: "late-build", title: "Late build", project: "/p", latestVersion: 3, updatedAt: "", pinned: false }] }
        : page(2, 3)))
      act(() => { window.dispatchEvent(new Event("focus")) })
      expect(await screen.findAllByRole("button", { name: "v3 available" })).toHaveLength(2)
      expect(mocks.authFetch).toHaveBeenCalledWith("/api/views")
    })

    it("keeps a reference still being written as a building block", () => {
      render(<CogpitView source="sales-funnel@3" complete={false} fallback={null} renderCode={renderCode} />)
      expect(screen.getByText(/The view appears when the reply finishes/)).toBeInTheDocument()
      expect(mocks.authFetch).not.toHaveBeenCalled()
    })
  })
})
