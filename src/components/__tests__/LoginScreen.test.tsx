import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LoginScreen } from "@/components/LoginScreen"

describe("LoginScreen", () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it("authenticates with a secure cookie request and never stores a token", async () => {
    localStorage.setItem("cogpit-network-token", "legacy-token")
    const onAuthenticated = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ valid: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))
    render(<LoginScreen onAuthenticated={onAuthenticated} />)

    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "correct horse battery staple" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    const [url, init] = fetchSpy.mock.calls[0]
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ valid: false, error: "Secure HTTPS is required for remote browser access" }),
      { status: 426, headers: { "Content-Type": "application/json" } },
    ))
    render(<LoginScreen onAuthenticated={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "password" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(await screen.findByText("Secure HTTPS is required for remote browser access")).toBeInTheDocument()
  })
})
