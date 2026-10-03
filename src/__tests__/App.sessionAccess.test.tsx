import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeviceRoot } from "@/components/DeviceRoot"
import { useSessionContext } from "@/contexts/SessionContext"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetServerHelloForTest } from "@/lib/auth"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { __resetSessionAccessForTest } from "@/lib/sessionAccess"
import { clearSessionListCache } from "@/lib/sessionListCache"
import type { SessionAccessLevel, SessionAccessLookup } from "../../shared/contracts/sessionAccess"
import { type MeResponse, NO_CAPABILITIES } from "../../shared/contracts/identity"
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

// The shell is where App hands over the composer, or what stands in for it.
vi.mock("@/components/AppShell/DesktopAppShell", () => ({
  DesktopAppShell: ({ sessionView }: { sessionView: { activeComposer: ReactNode; pendingComposer: ReactNode } }) => {
    const { session } = useSessionContext()
    return (
      <div>
        <span data-testid="open-session">{session?.sessionId ?? ""}</span>
        {sessionView.activeComposer === sessionView.pendingComposer
          ? <span>Composer</span>
          : sessionView.activeComposer}
      </div>
    )
  },
}))

const SESSION = "33333333-3333-4333-8333-333333333333"
const BOB_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_bob", username: "bob", displayName: "Bob" },
  capabilities: NO_CAPABILITIES,
  enforcesSessionAccess: true,
}
const TRANSCRIPT = toJsonl([
  userMsg("Ship the fix", { sessionId: SESSION }),
  textAssistant("Shipped.", { sessionId: SESSION }),
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

let answerMe: () => Response
let answerAccess: () => Promise<Response>
const accessRequests = vi.fn()
const configRequests = vi.fn<(method: string) => void>()

function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), "http://cogpit.test")
  const path = url.pathname
  if (path === "/api/hello") return Promise.resolve(json({ edition: "team", signIn: "account", setupRequired: false }))
  if (path === "/api/auth/session") return Promise.resolve(json({ ok: true }))
  if (path === "/api/me") return Promise.resolve(answerMe())
  if (path === `/api/session-config/${SESSION}.jsonl`) {
    configRequests(init?.method ?? "GET")
    return Promise.resolve(json({}))
  }
  if (path === "/api/config") return Promise.resolve(json({ claudeDir: "/home/bob/.claude", mode: "claude" }))
  if (path === `/api/sessions/-work-app/${SESSION}.jsonl`) {
    const lines = TRANSCRIPT.split("\n")
    return Promise.resolve(json({ headerLines: lines, tailLines: [], totalSize: TRANSCRIPT.length, byteOffset: 0, hasMore: false }))
  }
  if (path === `/api/session-access/${SESSION}`) {
    accessRequests()
    return answerAccess()
  }
  if (path === "/api/active-sessions" || path === "/api/running-processes") return Promise.resolve(json([]))
  return Promise.resolve(json({ error: "Not found" }, 404))
}

function lookup(level: SessionAccessLevel): SessionAccessLookup {
  return { sessionId: SESSION, level }
}

async function openSession(): Promise<void> {
  render(<DeviceRoot />)
  await waitFor(() => expect(screen.getByTestId("open-session")).toHaveTextContent(SESSION), { timeout: 5_000 })
}

describe("App session access where the server enforces it", () => {
  beforeEach(() => {
    __installEditionUiForTest({})
    window.history.replaceState(null, "", `/-work-app/${SESSION}`)
    localStorage.clear()
    clearSessionListCache()
    vi.stubGlobal("fetch", vi.fn(route))
    vi.stubGlobal("EventSource", SilentEventSource)
    answerMe = () => json(BOB_ME)
    accessRequests.mockReset()
    configRequests.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __resetEditionUiForTest()
    __resetServerHelloForTest()
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
    __resetSessionAccessForTest()
    window.history.replaceState(null, "", "/")
  })

  it("holds the composer back until the server says what the member may do", async () => {
    let grant!: (res: Response) => void
    answerAccess = () => new Promise((resolve) => { grant = resolve })

    await openSession()

    expect(screen.getByRole("status")).toHaveTextContent("Checking access…")
    expect(screen.queryByText("Composer")).not.toBeInTheDocument()

    await act(async () => grant(json(lookup("interact"))))

    expect(await screen.findByText("Composer")).toBeInTheDocument()
    expect(screen.queryByText("Checking access…")).not.toBeInTheDocument()
  })

  it("stays read-only through a failed lookup and asks again until the server answers", async () => {
    let attempts = 0
    answerAccess = async () => (++attempts === 1 ? json({ error: "Unavailable" }, 503) : json(lookup("view")))

    await openSession()
    await waitFor(() => expect(accessRequests).toHaveBeenCalledOnce())
    expect(screen.getByRole("status")).toHaveTextContent("Checking access…")

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("View only"), { timeout: 3_000 })
    expect(accessRequests).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Composer")).not.toBeInTheDocument()
  })

  it("writes nothing to an open session while the identity is unresolved", async () => {
    answerMe = () => json({ error: "Unavailable" }, 503)

    render(<DeviceRoot />)
    await waitFor(() => expect(configRequests).toHaveBeenCalledWith("GET"))
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    expect(screen.getByRole("status", { name: "Loading identity" })).toBeInTheDocument()
    expect(configRequests).not.toHaveBeenCalledWith("PUT")
    expect(accessRequests).not.toHaveBeenCalled()
  })
})
