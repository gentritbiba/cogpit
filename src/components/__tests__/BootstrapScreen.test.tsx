import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BootstrapScreen } from "@/components/BootstrapScreen"

const STRONG_PASSWORD = "correct horse battery staple"
const BOOTSTRAP_TOKEN = "bootstrap-token-with-at-least-32-characters"

interface MockServerOptions {
  status?: number
  body?: Record<string, unknown>
}

function mockServer({ status = 200, body = {} }: MockServerOptions = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url === "/api/team/bootstrap") {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

/** Fill the required fields; the form only submits once they are all valid. */
function fillCredentials(password = STRONG_PASSWORD) {
  fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "Gent " } })
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: password } })
  fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: password } })
}

function renderScreen() {
  const onAuthenticated = vi.fn()
  const onBootstrapClosed = vi.fn().mockResolvedValue(undefined)
  render(
    <BootstrapScreen onAuthenticated={onAuthenticated} onBootstrapClosed={onBootstrapClosed} />,
  )
  return { onAuthenticated, onBootstrapClosed }
}

describe("BootstrapScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    window.history.replaceState({}, "", `/#bootstrap=${BOOTSTRAP_TOKEN}`)
  })

  it("creates the first admin and enters the app on the shared auth path", async () => {
    const fetchSpy = mockServer({ body: { valid: true } })
    const { onAuthenticated, onBootstrapClosed } = renderScreen()

    fillCredentials()
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("/api/team/bootstrap")
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" })
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Cogpit-Client": "1",
      "X-Cogpit-Bootstrap-Token": BOOTSTRAP_TOKEN,
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "Gent",
      password: STRONG_PASSWORD,
    })
    // The cached probe must be re-read before the app renders authenticated,
    // or a later logout would land back on a bootstrap that no longer exists.
    expect(onBootstrapClosed).toHaveBeenCalledBefore(onAuthenticated)
    expect(screen.getByPlaceholderText("Password")).toHaveValue("")
    expect(window.location.hash).toBe("")
  })

  it("removes the setup credential from the URL and refuses submission without one", () => {
    window.history.replaceState({}, "", "/")
    const fetchSpy = mockServer()
    renderScreen()

    fillCredentials()

    expect(screen.getByText(/one-time setup URL/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create admin account" })).toBeDisabled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("sends an optional display name when one is given", async () => {
    const fetchSpy = mockServer({ body: { valid: true } })
    renderScreen()

    fillCredentials()
    fireEvent.change(screen.getByPlaceholderText("Display name (optional)"), {
      target: { value: "Gentrit" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      displayName: "Gentrit",
    })
  })

  it("shows the server's validation error verbatim", async () => {
    mockServer({ status: 400, body: { error: "Username is already taken" } })
    const { onAuthenticated } = renderScreen()

    fillCredentials()
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    expect(await screen.findByText("Username is already taken")).toBeInTheDocument()
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it("shows the HTTPS requirement returned by the server", async () => {
    mockServer({
      status: 426,
      body: { valid: false, error: "Secure HTTPS is required for remote browser access" },
    })
    renderScreen()

    fillCredentials()
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    expect(
      await screen.findByText("Secure HTTPS is required for remote browser access"),
    ).toBeInTheDocument()
  })

  it("falls through to the login screen when another founder wins the race", async () => {
    mockServer({ status: 410, body: { error: "Already bootstrapped" } })
    const { onAuthenticated, onBootstrapClosed } = renderScreen()

    fillCredentials()
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    await waitFor(() => expect(onBootstrapClosed).toHaveBeenCalledOnce())
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it("holds the submit until the two passwords match", () => {
    mockServer()
    renderScreen()

    fireEvent.change(screen.getByPlaceholderText("Username"), { target: { value: "gent" } })
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: STRONG_PASSWORD } })
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), {
      target: { value: "correct horse battery stapl" },
    })

    expect(screen.getByRole("button", { name: "Create admin account" })).toBeDisabled()
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument()
  })

  it("holds the submit until the password is long enough", () => {
    mockServer()
    renderScreen()

    fillCredentials("short-one")

    expect(screen.getByRole("button", { name: "Create admin account" })).toBeDisabled()
  })

  it("reports a failure to reach the server", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    renderScreen()

    fillCredentials()
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }))

    expect(await screen.findByText("Failed to connect to server")).toBeInTheDocument()
  })
})
