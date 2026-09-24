import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceRoot } from "@/components/DeviceRoot"
import { __resetServerHelloForTest } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { clearSessionListCache } from "@/lib/sessionListCache"
import { ALL_CAPABILITIES, type MeResponse } from "../../../shared/contracts/identity"
import { useEditionUi, useMainViews } from "../hooks"
import { editionUiState } from "../registry"

const editionUi = vi.hoisted(() => ({ imports: 0 }))

vi.mock("@cogpit/edition-ui", () => {
  editionUi.imports += 1
  return { default: null }
})

vi.mock("@/hooks/useParserWorker", () => ({
  useParserWorker: () => ({ parse: async () => null, append: async () => null }),
}))

/** Stands in for the shell and reports the slots it would render from. */
function SlotProbe() {
  const slots = Object.keys(useEditionUi()).join(",")
  const mainViews = useMainViews().map((view) => view.id).join(",")
  return <div data-testid="app-shell" data-slots={slots} data-main-views={mainViews} />
}

vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: SlotProbe,
}))

const PERSONAL: MeResponse = {
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: ALL_CAPABILITIES,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function route(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://cogpit.test").pathname
  if (path === "/api/hello") return Promise.resolve(json({ edition: "personal", signIn: "password", setupRequired: false }))
  if (path === "/api/me") return Promise.resolve(json(PERSONAL))
  if (path === "/api/config") return Promise.resolve(json({ claudeDir: "/home/me/.claude", mode: "claude" }))
  return Promise.resolve(json({ error: "Not found" }, 404))
}

describe("App on a personal server", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/")
    localStorage.clear()
    clearSessionListCache()
    vi.stubGlobal("fetch", vi.fn(route))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetServerHelloForTest()
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
  })

  it("never downloads the edition UI", async () => {
    render(<DeviceRoot />)

    expect(await screen.findByTestId("app-shell", {}, { timeout: 5_000 })).toBeInTheDocument()
    expect(editionUi.imports).toBe(0)
    expect(editionUiState()).toBe("idle")
  })

  it("requests every session list unfiltered", async () => {
    render(<DeviceRoot />)
    await screen.findByTestId("app-shell", {}, { timeout: 5_000 })

    const lists = vi.mocked(fetch).mock.calls
      .map(([input]) => new URL(String(input), "http://cogpit.test"))
      .filter((url) => url.pathname === "/api/active-sessions")
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.map((url) => url.search)).toEqual(lists.map(() => ""))
  })

  it("renders no account control, header actions, badges or main views", async () => {
    render(<DeviceRoot />)

    const shell = await screen.findByTestId("app-shell", {}, { timeout: 5_000 })
    expect(shell).toHaveAttribute("data-slots", "")
    expect(shell).toHaveAttribute("data-main-views", "")
  })
})
