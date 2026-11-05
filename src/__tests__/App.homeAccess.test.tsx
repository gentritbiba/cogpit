import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceRoot } from "@/components/DeviceRoot"
import type { DesktopNavigation } from "@/components/AppShell/desktopTypes"
import { useSessionContext } from "@/contexts/SessionContext"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetServerHelloForTest } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { __resetSessionAccessForTest } from "@/lib/sessionAccess"
import { clearSessionListCache } from "@/lib/sessionListCache"
import { ALL_CAPABILITIES, type MeResponse } from "../../shared/contracts/identity"
import { textAssistant, toJsonl, userMsg } from "./fixtures"

vi.mock("@/hooks/useParserWorker", async () => {
  const { parseSession } = await import("../../shared/session/parser")
  return {
    useParserWorker: () => ({
      parse: async (text: string) => parseSession(text),
      append: async () => null,
    }),
  }
})

// Mission Control's composer reaches App through the shell's navigation; this
// stand-in starts the next session from the home the way it does.
vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: ({ navigation }: { navigation: DesktopNavigation }) => {
    const { session } = useSessionContext()
    return (
      <div>
        <span data-testid="open-session">{session?.sessionId ?? ""}</span>
        <button onClick={() => void navigation.onStartNewSessionWith("-work-next", "/work/next", "Explain this project", undefined, "bypassPermissions")}>
          Start from home with Full access
        </button>
      </div>
    )
  },
}))

const SESSION = "44444444-4444-4444-8444-444444444444"
const ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_amy", username: "amy", displayName: "Amy" },
  capabilities: ALL_CAPABILITIES,
  enforcesSessionAccess: true,
}
const TRANSCRIPT = toJsonl([
  userMsg("Tidy the CSS", { sessionId: SESSION }),
  textAssistant("Tidied.", { sessionId: SESSION }),
] as unknown as Array<Record<string, unknown>>)

class SilentEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const openSessionConfig = vi.fn<(method: string, body: unknown) => void>()
const created = vi.fn<(body: { permissions?: { mode?: string }; cwd?: string }) => void>()

function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input), "http://cogpit.test").pathname
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
  if (path === "/api/hello") return Promise.resolve(json({ edition: "team", signIn: "account", setupRequired: false }))
  if (path === "/api/auth/session") return Promise.resolve(json({ ok: true }))
  if (path === "/api/me") return Promise.resolve(json(ME))
  if (path === "/api/config") return Promise.resolve(json({ claudeDir: "/home/amy/.claude", mode: "claude" }))
  if (path === `/api/session-access/${SESSION}`) return Promise.resolve(json({ sessionId: SESSION, level: "own" }))
  // The open session runs restricted.
  if (path === `/api/session-config/${SESSION}.jsonl`) {
    openSessionConfig(init?.method ?? "GET", body)
    return Promise.resolve(json({ permissionMode: "default" }))
  }
  if (path === `/api/sessions/-work-app/${SESSION}.jsonl`) {
    const lines = TRANSCRIPT.split("\n")
    return Promise.resolve(json({ headerLines: lines, tailLines: [], totalSize: TRANSCRIPT.length, byteOffset: 0, hasMore: false }))
  }
  if (path === "/api/create-and-send") {
    created(body as { permissions?: { mode?: string } })
    return Promise.resolve(json({ error: "Stopped by the test before any agent ran." }, 503))
  }
  if (path === "/api/active-sessions" || path === "/api/running-processes" || path === "/api/projects") return Promise.resolve(json([]))
  return Promise.resolve(json({ error: "Not found" }, 404))
}

describe("access chosen on Mission Control", () => {
  beforeEach(() => {
    __installEditionUiForTest({})
    window.history.replaceState(null, "", `/-work-app/${SESSION}`)
    localStorage.clear()
    clearSessionListCache()
    vi.stubGlobal("fetch", vi.fn(route))
    vi.stubGlobal("EventSource", SilentEventSource)
    openSessionConfig.mockReset()
    created.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetEditionUiForTest()
    __resetServerHelloForTest()
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
    __resetSessionAccessForTest()
    window.history.replaceState(null, "", "/")
  })

  it("starts the new session with it and never writes it into the session open behind the home", async () => {
    render(<DeviceRoot />)
    await waitFor(() => expect(screen.getByTestId("open-session")).toHaveTextContent(SESSION), { timeout: 5_000 })
    await waitFor(() => expect(openSessionConfig).toHaveBeenCalledWith("GET", undefined))
    // A moment on the home: the open session's access and config have settled.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start from home with Full access" }))
    })

    await waitFor(() => expect(created).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(created.mock.calls[0]![0]).toMatchObject({ cwd: "/work/next", permissions: { mode: "bypassPermissions" } })
    expect(openSessionConfig.mock.calls.filter(([method]) => method !== "GET")).toEqual([])
  })
})
