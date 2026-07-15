import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PreviewPanel, normalizePreviewUrl } from "@/components/PreviewPanel"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

describe("normalizePreviewUrl", () => {
  it("adds http to host-and-port input and rejects non-web protocols", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/")
    expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull()
  })
})

describe("PreviewPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "dev-server",
        ports: [5173],
        portStatus: { 5173: true },
        preview: "Vite dev server",
      }],
    })
  })

  it("discovers a listening development server and opens its preview", async () => {
    const user = userEvent.setup()
    render(<PreviewPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    const portButton = await screen.findByRole("button", { name: "Open localhost:5173 preview" })
    await user.click(portButton)

    expect(screen.getByTitle("Development preview")).toHaveAttribute(
      "src",
      `http://${window.location.hostname || "localhost"}:5173/`,
    )
  })

  it("supports preview-focused URL and refresh shortcuts", async () => {
    const user = userEvent.setup()
    render(<PreviewPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Open localhost:5173 preview" }))
    const frame = screen.getByTitle("Development preview")
    fireEvent.load(frame)

    const refreshButton = screen.getByRole("button", { name: "Refresh preview" })
    refreshButton.focus()
    fireEvent.keyDown(window, { key: "l", metaKey: true })
    expect(screen.getByRole("textbox", { name: "Preview URL" })).toHaveFocus()

    fireEvent.keyDown(window, { key: "r", metaKey: true })
    expect(refreshButton.querySelector("svg")).toHaveClass("animate-spin")
  })

  it("switches viewport presets and supports preview zoom controls", async () => {
    const user = userEvent.setup()
    render(<PreviewPanel cwd="/workspace/cogpit" onClose={vi.fn()} />)

    await user.click(await screen.findByRole("button", { name: "Open localhost:5173 preview" }))
    await user.click(screen.getByRole("button", { name: "Phone viewport" }))

    const frame = screen.getByTitle("Development preview")
    expect(frame).toHaveStyle({ width: "390px", height: "844px", transform: "scale(1)" })

    const zoomIn = screen.getByRole("button", { name: "Zoom preview in" })
    zoomIn.focus()
    fireEvent.keyDown(window, { key: "=", metaKey: true })
    expect(screen.getByRole("button", { name: "Reset preview zoom" })).toHaveTextContent("110%")
    expect(frame).toHaveStyle({ transform: "scale(1.1)" })

    fireEvent.keyDown(window, { key: "0", metaKey: true })
    expect(screen.getByRole("button", { name: "Reset preview zoom" })).toHaveTextContent("100%")
  })
})
