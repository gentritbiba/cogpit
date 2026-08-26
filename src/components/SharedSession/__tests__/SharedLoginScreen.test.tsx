import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SharedLoginScreen } from "@/components/SharedSession/SharedLoginScreen"

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function typePassphrase(value = "copper-lantern-drift-92") {
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value } })
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }))
}

describe("SharedLoginScreen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders a single passphrase field and no username field", () => {
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    expect(screen.getByLabelText("Passphrase")).toBeInTheDocument()
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument()
  })

  it("posts the passphrase to /api/share/verify with the client header", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(200, { valid: true }))
    const onAuthenticated = vi.fn()

    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={onAuthenticated} />)
    typePassphrase()
    submit()

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/share/verify")
    expect(init.method).toBe("POST")
    expect(init.credentials).toBe("same-origin")
    expect(init.cache).toBe("no-store")
    expect((init.headers as Record<string, string>)["X-Cogpit-Client"]).toBe("1")
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "s-1",
      passphrase: "copper-lantern-drift-92",
    })
  })

  it("never sends an Authorization header", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(200, { valid: true }))
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("Authorization")
  })

  it("shows one generic message on 401 that does not reveal whether the share exists", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(401, { error: "Invalid link or passphrase" }),
    )
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Invalid link or passphrase")
    expect(alert.textContent).not.toMatch(/not shared|unknown|no such|does not exist/i)
  })

  it("shows a rate-limit message on 429", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(429, { error: "Too many attempts. Try again in 1 minute." }),
    )
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()
    expect(await screen.findByRole("alert")).toHaveTextContent(/too many attempts/i)
  })

  it("shows the HTTPS/tunnel hint on 426", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(426, { error: "Secure HTTPS is required" }))
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()
    expect(await screen.findByRole("alert")).toHaveTextContent(/https.*tunnel|tunnel.*https/i)
  })

  it("says network access is off on 403", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { error: "Network access is disabled" }))
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()
    expect(await screen.findByRole("alert")).toHaveTextContent(/network access is (off|disabled)/i)
  })

  it("reports a connection failure rather than hanging", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("boom"))
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    typePassphrase()
    submit()
    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to connect/i)
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()
  })

  it("disables submit while empty and while the request is in flight", async () => {
    let release: (value: Response) => void = () => {}
    vi.mocked(fetch).mockReturnValue(new Promise<Response>((resolve) => { release = resolve }))

    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled()

    typePassphrase()
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()

    submit()
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled())

    release(jsonResponse(401, { error: "Invalid link or passphrase" }))
    await screen.findByRole("alert")
  })

  it("treats a 200 that is not valid as a failure", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { valid: false }))
    const onAuthenticated = vi.fn()
    render(<SharedLoginScreen sessionId="s-1" onAuthenticated={onAuthenticated} />)
    typePassphrase()
    submit()
    await screen.findByRole("alert")
    expect(onAuthenticated).not.toHaveBeenCalled()
  })
})
