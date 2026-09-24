import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceRoot } from "@/components/DeviceRoot"
import type { SetupScreenProps } from "@/edition/contract"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetServerHelloForTest } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { clearSessionListCache } from "@/lib/sessionListCache"

vi.mock("@/hooks/useParserWorker", () => ({
  useParserWorker: () => ({ parse: async () => null, append: async () => null }),
}))

vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: () => <div data-testid="app-shell" />,
}))

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

let setupRequired: boolean

/** A server with account sign-in and, until `setupRequired` flips, no account yet. */
function route(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://cogpit.test").pathname
  if (path === "/api/hello") return Promise.resolve(json({ edition: "team", signIn: "account", setupRequired }))
  return Promise.resolve(json({ error: "Sign in" }, 401))
}

describe("App on a server with no account yet", () => {
  beforeEach(() => {
    setupRequired = true
    window.history.replaceState(null, "", "/")
    localStorage.clear()
    clearSessionListCache()
    vi.stubGlobal("fetch", vi.fn(route))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetEditionUiForTest()
    __resetServerHelloForTest()
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
  })

  it("says so on the sign-in form when no edition UI can set it up", async () => {
    __installEditionUiForTest({})
    render(<DeviceRoot />)

    expect(await screen.findByText("This server has no accounts yet.", {}, { timeout: 5_000 })).toBeInTheDocument()
    expect(await screen.findByPlaceholderText("Username")).toBeInTheDocument()
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument()
  })

  it("hands first-time setup to the edition's setup screen, then re-reads the server", async () => {
    const SetupScreen = vi.fn(({ onSetupClosed }: SetupScreenProps) => (
      <button type="button" onClick={() => void onSetupClosed()}>Finish setup</button>
    ))
    __installEditionUiForTest({ SetupScreen })
    const user = userEvent.setup()
    render(<DeviceRoot />)

    const finish = await screen.findByRole("button", { name: "Finish setup" }, { timeout: 5_000 })
    setupRequired = false
    await user.click(finish)

    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument()
    expect(screen.queryByText("This server has no accounts yet.")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Finish setup" })).not.toBeInTheDocument()
  })
})
