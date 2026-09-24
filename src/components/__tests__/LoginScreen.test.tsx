import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LoginScreen } from "@/components/LoginScreen"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetServerHelloForTest } from "@/lib/auth"

interface MockServerOptions {
  signIn?: "password" | "account"
  verify?: { status: number; body: Record<string, unknown> }
}

/** Route the hello handshake and the verify endpoint through one fetch spy. */
function mockServer({
  signIn = "password",
  verify = { status: 200, body: { valid: true } },
}: MockServerOptions = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url === "/api/hello") {
      return new Response(
        JSON.stringify({ app: "cogpit", signIn }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (url === "/api/auth/verify") {
      return new Response(
        JSON.stringify(verify.body),
        { status: verify.status, headers: { "Content-Type": "application/json" } },
      )
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

/** The single /api/auth/verify call recorded by the spy (throws if absent). */
function verifyCall(fetchSpy: ReturnType<typeof mockServer>) {
  const call = fetchSpy.mock.calls.find(([input]) => String(input) === "/api/auth/verify")
  if (!call) throw new Error("No /api/auth/verify request was made")
  return call
}

describe("LoginScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    __resetServerHelloForTest()
    __resetEditionUiForTest()
  })

  it("authenticates with a secure cookie request and never stores a token", async () => {
    localStorage.setItem("cogpit-network-token", "legacy-token")
    const onAuthenticated = vi.fn()
    const fetchSpy = mockServer()
    render(<LoginScreen onAuthenticated={onAuthenticated} />)

    fireEvent.change(await screen.findByPlaceholderText("Password"), { target: { value: "correct horse battery staple" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    const [url, init] = verifyCall(fetchSpy)
    expect(url).toBe("/api/auth/verify")
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" })
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer correct horse battery staple",
      "X-Cogpit-Client": "1",
    })
    expect(localStorage.getItem("cogpit-network-token")).toBeNull()
    expect(sessionStorage.getItem("cogpit-network-token")).toBeNull()
    expect(screen.getByPlaceholderText("Password")).toHaveValue("")
  })

  it("shows the HTTPS requirement returned by the server", async () => {
    mockServer({
      verify: { status: 426, body: { valid: false, error: "Secure HTTPS is required for remote browser access" } },
    })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    fireEvent.change(await screen.findByPlaceholderText("Password"), { target: { value: "password" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByText("Secure HTTPS is required for remote browser access")).toBeInTheDocument()
  })

  it("keeps the password-only Bearer flow on a password server", async () => {
    const fetchSpy = mockServer({ signIn: "password" })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    fireEvent.change(await screen.findByPlaceholderText("Password"), { target: { value: "correct horse battery staple" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(verifyCall(fetchSpy)).toBeTruthy())
    expect(screen.queryByPlaceholderText("Username")).not.toBeInTheDocument()
    const [, init] = verifyCall(fetchSpy)
    expect(init?.headers).toMatchObject({ Authorization: "Bearer correct horse battery staple" })
  })

  it("renders a username field above the password for an account server", async () => {
    mockServer({ signIn: "account" })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    const username = await screen.findByPlaceholderText("Username")
    expect(username).toHaveAttribute("autocomplete", "username")
    const password = screen.getByPlaceholderText("Password")
    expect(username.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Both credentials are required before the form submits
    fireEvent.change(password, { target: { value: "pw" } })
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled()
    expect(screen.getByText("Sign in with your account to continue.")).toBeInTheDocument()
  })

  it("shows the edition's notice under an account sign-in", async () => {
    __installEditionUiForTest({ LoginNotice: () => <p>Read this first.</p> })
    mockServer({ signIn: "account" })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    await screen.findByPlaceholderText("Username")
    expect(screen.getByText("Read this first.")).toBeInTheDocument()
  })

  it("shows no edition notice on a password server", async () => {
    __installEditionUiForTest({ LoginNotice: () => <p>Read this first.</p> })
    mockServer({ signIn: "password" })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    await screen.findByPlaceholderText("Password")
    expect(screen.queryByText("Read this first.")).not.toBeInTheDocument()
  })

  it("submits account credentials as a JSON body, not a Bearer header", async () => {
    const onAuthenticated = vi.fn()
    const fetchSpy = mockServer({ signIn: "account" })
    render(<LoginScreen onAuthenticated={onAuthenticated} />)

    fireEvent.change(await screen.findByPlaceholderText("Username"), { target: { value: "Alice " } })
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "correct horse battery staple" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    const [, init] = verifyCall(fetchSpy)
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" })
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json", "X-Cogpit-Client": "1" })
    expect(init?.headers).not.toHaveProperty("Authorization")
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "Alice",
      password: "correct horse battery staple",
    })
    // Success clears both credentials from state
    expect(screen.getByPlaceholderText("Username")).toHaveValue("")
    expect(screen.getByPlaceholderText("Password")).toHaveValue("")
  })

  it("holds the credential fields until the sign-in resolves so a late account answer cannot steal focus", async () => {
    let resolveHello!: (r: Response) => void
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/hello") {
        return new Promise<Response>((resolve) => { resolveHello = resolve })
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    // No credential fields while the sign-in is unknown — nothing to focus,
    // nothing to start typing a password into.
    expect(screen.queryByPlaceholderText("Password")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Username")).not.toBeInTheDocument()

    resolveHello(new Response(JSON.stringify({ signIn: "account" }), { status: 200 }))
    const username = await screen.findByPlaceholderText("Username")
    expect(username).toHaveFocus()
  })

  it("autofocuses the password field once password sign-in resolves", async () => {
    mockServer({ signIn: "password" })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    const password = await screen.findByPlaceholderText("Password")
    expect(password).toHaveFocus()
  })

  it("shows the server's account sign-in error verbatim and keeps the username", async () => {
    mockServer({
      signIn: "account",
      verify: { status: 403, body: { valid: false, error: "Account disabled" } },
    })
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    fireEvent.change(await screen.findByPlaceholderText("Username"), { target: { value: "alice" } })
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByText("Account disabled")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Username")).toHaveValue("alice")
  })
})
