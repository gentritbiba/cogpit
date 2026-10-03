import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ALL_CAPABILITIES, type CogpitEdition, type MeResponse } from "../../../shared/contracts/identity"

/** What the build's `@cogpit/edition-ui` chunk does when the app asks for it. */
const chunk = { outcome: "fail" as "fail" | "team" | "pending", asked: false }

function editionUiChunk() {
  chunk.asked = true
  if (chunk.outcome === "fail") throw new Error("Failed to fetch dynamically imported module")
  if (chunk.outcome === "pending") return new Promise(() => {})
  return { default: { edition: "team", ui: {} } }
}

vi.mock("@/hooks/useParserWorker", () => ({
  useParserWorker: () => ({ parse: async () => null, append: async () => null }),
}))

vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: () => <div data-testid="app-shell" />,
}))

const RELOAD_FLAG = "cogpit:edition-ui-reloaded"

const PERSONAL_ME: MeResponse = { authenticated: true, edition: "personal", user: null, capabilities: ALL_CAPABILITIES }
const TEAM_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_alice", username: "alice", displayName: "Alice" },
  capabilities: ALL_CAPABILITIES,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function hello(edition: CogpitEdition): Response {
  return json(edition === "personal"
    ? { edition, signIn: "password", setupRequired: false }
    : { edition, signIn: "account", setupRequired: false })
}

/** A hub of `hubEdition` with one remote device, `box`, of team edition. */
function serve(hubEdition: CogpitEdition) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://cogpit.test").pathname
    if (path === "/api/hello") return Promise.resolve(hello(hubEdition))
    if (path === "/api/auth/session") return Promise.resolve(json({ error: "Sign in" }, 401))
    if (path === "/api/me") return Promise.resolve(json(hubEdition === "personal" ? PERSONAL_ME : TEAM_ME))
    if (path === "/hub/box/api/hello") return Promise.resolve(hello("team"))
    if (path === "/hub/box/api/me") return Promise.resolve(json(TEAM_ME))
    return Promise.resolve(json({ error: "Not found" }, 404))
  }
}

// The loader keeps the chunk it imported for the page, so each test starts on a fresh page.
let DeviceRoot: typeof import("@/components/DeviceRoot").DeviceRoot

describe("App while the edition UI chunk loads", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.doMock("@cogpit/edition-ui", editionUiChunk)
    chunk.asked = false
    window.history.replaceState(null, "", "/")
    localStorage.clear()
    sessionStorage.clear()
    ;({ DeviceRoot } = await import("@/components/DeviceRoot"))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows a retry error when the server's own edition UI cannot be fetched, then signs in once it loads", async () => {
    chunk.outcome = "fail"
    // The page already reloaded once for this chunk.
    sessionStorage.setItem(RELOAD_FLAG, "1")
    vi.stubGlobal("fetch", vi.fn(serve("team")))
    const user = userEvent.setup()
    render(<DeviceRoot />)

    const retry = await screen.findByRole("button", { name: "Retry" }, { timeout: 5_000 })
    expect(screen.getByText("Cogpit couldn’t finish loading")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Username")).not.toBeInTheDocument()
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()

    chunk.outcome = "team"
    await user.click(retry)

    expect(await screen.findByPlaceholderText("Username")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()
  })

  it("waits under the identity spinner while a remote device's edition UI loads", async () => {
    chunk.outcome = "pending"
    window.history.replaceState(null, "", "/d/box")
    vi.stubGlobal("fetch", vi.fn(serve("personal")))
    render(<DeviceRoot />)

    // The device's identity is in, so its edition UI has been asked for.
    await waitFor(() => expect(chunk.asked).toBe(true), { timeout: 5_000 })
    expect(screen.getByRole("status", { name: "Loading identity" })).toBeInTheDocument()
    expect(screen.queryByRole("status", { name: "Checking authentication" })).not.toBeInTheDocument()
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument()
  })
})
