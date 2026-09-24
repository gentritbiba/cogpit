import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceRoot } from "@/components/DeviceRoot"
import type { GateScreenProps } from "@/edition/contract"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetServerHelloForTest } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { clearSessionListCache } from "@/lib/sessionListCache"
import { ALL_CAPABILITIES, GATE_HEADER, type MeResponse } from "../../shared/contracts/identity"

vi.mock("@/hooks/useParserWorker", () => ({
  useParserWorker: () => ({ parse: async () => null, append: async () => null }),
}))

vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: () => <div data-testid="app-shell" />,
}))

const GATED: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_alice", username: "alice", displayName: "Alice" },
  capabilities: ALL_CAPABILITIES,
  enforcesSessionAccess: true,
  gate: "maintenance",
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

/** A server that keeps its caller out: it answers who they are, and refuses the rest behind its gate. */
function route(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://cogpit.test").pathname
  if (path === "/api/hello") return Promise.resolve(json({ edition: "team", signIn: "account", setupRequired: false }))
  if (path === "/api/auth/session") return Promise.resolve(json({ ok: true }))
  if (path === "/api/me") return Promise.resolve(json(GATED))
  return Promise.resolve(json({ error: "Not now" }, 403, { [GATE_HEADER]: GATED.gate! }))
}

describe("App on a server that keeps the caller out", () => {
  beforeEach(() => {
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

  it("shows the default gate screen for a gate no edition UI explains", async () => {
    __installEditionUiForTest({})
    render(<DeviceRoot />)

    expect(await screen.findByText("This server isn’t available to your account right now", {}, { timeout: 5_000 }))
      .toBeInTheDocument()
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument()
  })

  it("hands the gate to the edition's gate screen, which can sign out", async () => {
    const GateScreen = vi.fn(({ gate, onLogout }: GateScreenProps) => (
      <button type="button" onClick={onLogout}>Gate: {gate}</button>
    ))
    __installEditionUiForTest({ GateScreen })
    const user = userEvent.setup()
    render(<DeviceRoot />)

    await user.click(await screen.findByRole("button", { name: "Gate: maintenance" }, { timeout: 5_000 }))

    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }))
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument()
  })
})
