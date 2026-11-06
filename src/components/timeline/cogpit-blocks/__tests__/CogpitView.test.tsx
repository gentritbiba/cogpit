import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadViewLibraries: vi.fn(),
  composer: null as null | { snapshot: () => unknown; replace: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> },
}))
vi.mock("../view/libraries", () => ({ loadViewLibraries: mocks.loadViewLibraries }))
vi.mock("@/plugins/composerBridge", () => ({ activeComposer: () => mocks.composer }))

import CogpitView from "../view/CogpitView"

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
    render(<CogpitView source={SOURCE} complete={false} fallback={<pre>source</pre>} />)
    expect(screen.getByText(/The view appears when the reply finishes/)).toBeInTheDocument()
    expect(screen.queryByTitle("Sine wave")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(screen.getByText("source")).toBeInTheDocument()
  })

  it("runs the view in a sandbox with no origin of its own", () => {
    render(<CogpitView source={SOURCE} complete fallback={null} />)
    expect(screen.getByRole("heading", { name: "Sine wave" })).toBeInTheDocument()
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame().getAttribute("src")).toBe("/api/views/shell/v1")
  })

  it("sends the composed page and its libraries once the sandbox is ready", async () => {
    render(<CogpitView source={SOURCE} complete fallback={null} />)
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
    render(<CogpitView source={SOURCE} complete fallback={null} />)
    const send = vi.spyOn(frame().contentWindow!, "postMessage")
    post({ cogpitView: 1, type: "ready" }, window)
    await act(() => new Promise((done) => setTimeout(done, 0)))
    expect(send).not.toHaveBeenCalled()
  })

  it("sizes the frame to its page within bounds", () => {
    render(<CogpitView source={SOURCE} complete fallback={null} />)
    post({ cogpitView: 1, type: "resize", height: 412 })
    expect(frame().style.height).toBe("412px")
    post({ cogpitView: 1, type: "resize", height: 90_000 })
    expect(frame().style.height).toBe("1600px")
  })

  it("shows a script error and lets the user ask the agent to fix it", () => {
    const replace = vi.fn(() => ({}))
    mocks.composer = { snapshot: () => ({ token: "t1", draft: { v: 1, text: "Earlier note", context: [], attachments: [] } }), replace, focus: vi.fn() }
    render(<CogpitView source={SOURCE} complete fallback={null} />)
    post({ cogpitView: 1, type: "error", message: "d3 is not defined" })
    expect(screen.getByRole("alert")).toHaveTextContent("d3 is not defined")
    fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }))
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^Earlier note\n\nThe interactive view "Sine wave" shows this error: d3 is not defined/) }), "t1")
  })

  it("acts on links and questions only while the user is inside the view", () => {
    const replace = vi.fn(() => ({}))
    mocks.composer = { snapshot: () => ({ token: "t1", draft: { v: 1, text: "", context: [], attachments: [] } }), replace, focus: vi.fn() }
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(<CogpitView source={SOURCE} complete fallback={null} />)
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
})
