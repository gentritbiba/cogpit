import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SharedRoot } from "@/components/SharedSession/SharedRoot"
import { SHARE_REVOKED_EVENT } from "@/lib/shareApi"

// The session view mounts the whole transcript pipeline; SharedRoot's job is
// only to decide when it is allowed to exist.
vi.mock("@/components/SharedSession/SharedSessionView", () => ({
  SharedSessionView: ({ info }: { info: { title: string } }) => (
    <div data-testid="session-view">{info.title}</div>
  ),
}))

const INFO = {
  sessionId: "sess-1",
  dirName: "-Users-me-proj",
  fileName: "sess-1.jsonl",
  title: "Shared session",
  provider: "claude",
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe("SharedRoot", () => {
  beforeEach(() => {
    history.pushState({}, "", "/shared/sess-1")
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    history.pushState({}, "", "/")
  })

  it("probes the share before rendering anything else", async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, INFO))
    render(<SharedRoot />)

    expect(screen.getByRole("status")).toBeInTheDocument()
    await screen.findByTestId("session-view")

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/share/session")
    expect((init.headers as Record<string, string>)["X-Cogpit-Client"]).toBe("1")
  })

  it("renders the login screen when the guest has no token yet", async () => {
    vi.mocked(fetch).mockResolvedValue(json(401, { error: "Share authentication required" }))
    render(<SharedRoot />)
    expect(await screen.findByLabelText("Passphrase")).toBeInTheDocument()
    expect(screen.queryByTestId("session-view")).not.toBeInTheDocument()
  })

  it("re-probes after a successful login and shows the session", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: "nope" }))
      .mockResolvedValueOnce(json(200, { valid: true }))
      .mockResolvedValueOnce(json(200, INFO))

    render(<SharedRoot />)
    fireEvent.change(await screen.findByLabelText("Passphrase"), { target: { value: "a-b-c-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByTestId("session-view")).toHaveTextContent("Shared session")
  })

  it("shows a recoverable error with a retry, not a spinner that hangs", async () => {
    vi.mocked(fetch).mockResolvedValue(json(500, { error: "boom" }))
    render(<SharedRoot />)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()

    vi.mocked(fetch).mockResolvedValue(json(200, INFO))
    fireEvent.click(screen.getByRole("button", { name: /try again/i }))
    expect(await screen.findByTestId("session-view")).toBeInTheDocument()
  })

  it("ends terminally when the share is revoked mid-session", async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, INFO))
    render(<SharedRoot />)
    await screen.findByTestId("session-view")

    act(() => { window.dispatchEvent(new Event(SHARE_REVOKED_EVENT)) })

    expect(await screen.findByText(/sharing (has )?ended|no longer shared/i)).toBeInTheDocument()
    expect(screen.queryByTestId("session-view")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument()
  })

  it("treats the auth-required signal from a reused host hook as revocation", async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, INFO))
    render(<SharedRoot />)
    await screen.findByTestId("session-view")

    act(() => { window.dispatchEvent(new Event("cogpit-auth-required")) })

    expect(await screen.findByText(/sharing (has )?ended|no longer shared/i)).toBeInTheDocument()
  })

  it("does not mistake the pre-login 401 for a revoked share", async () => {
    vi.mocked(fetch).mockResolvedValue(json(401, { error: "Share authentication required" }))
    render(<SharedRoot />)

    await screen.findByLabelText("Passphrase")
    await waitFor(() => expect(screen.queryByText(/sharing (has )?ended/i)).not.toBeInTheDocument())
  })

  it("reports a malformed share URL instead of probing", async () => {
    history.pushState({}, "", "/shared/")
    render(<SharedRoot />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/link/i)
    expect(fetch).not.toHaveBeenCalled()
  })
})
