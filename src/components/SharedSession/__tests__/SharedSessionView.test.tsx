import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SharedSessionView } from "@/components/SharedSession/SharedSessionView"
import { useSessionContext } from "@/contexts/SessionContext"
import { sessionCache } from "@/lib/sessionCache"
import { __resetCapabilitiesForTest, can } from "@/lib/capabilities"

// The worker transport is unavailable in jsdom; parsing itself is the real
// implementation, so only the postMessage hop is replaced.
vi.mock("@/hooks/useParserWorker", async () => {
  const { parseSession, parseSessionAppend } = await import("../../../../shared/session/parser")
  return {
    useParserWorker: () => ({
      parse: async (text: string) => parseSession(text),
      append: async (existing: never, newText: string) => parseSessionAppend(existing, newText),
    }),
  }
})

// Stands in for the virtualizer, which cannot measure in jsdom. It reads the
// same context the real timeline does and renders the same TurnSection, so the
// requests a rendered turn makes are still the real ones.
vi.mock("@/components/ConversationTimeline", async () => {
  const { TurnSection } = await import("@/components/timeline/TurnSection")
  return {
    ConversationTimeline: () => {
      const { session } = useSessionContext()
      return (
        <div data-testid="timeline">
          {session?.turns.map((turn, i) => <TurnSection key={i} turn={turn} index={i} />)}
        </div>
      )
    },
  }
})

const INFO = {
  sessionId: "sess-1",
  dirName: "-Users-me-proj",
  fileName: "sess-1.jsonl",
  title: "Shared session",
  provider: "claude" as const,
}

const TRANSCRIPT = [
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-08-25T10:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/Users/me/proj",
    message: { role: "user", content: "hello from the host" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-08-25T10:00:01.000Z",
    sessionId: "sess-1",
    message: { role: "assistant", content: [{ type: "text", text: "hi from the agent" }] },
  }),
]

const PERMISSION = {
  requestId: "req-1",
  toolName: "Bash",
  input: { command: "rm -rf /tmp/x" },
  toolUseId: "tu-1",
  timestamp: 1,
}

interface Call { url: string; init?: RequestInit }

function calls(): Call[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => ({
    url: String(url),
    init: init as RequestInit | undefined,
  }))
}

function findCall(fragment: string): Call | undefined {
  return calls().find((call) => call.url.includes(fragment))
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

function respond(url: string, pending: { permissions: unknown[] }): Response {
  if (url.includes("/api/sessions/")) {
    return json({
      headerLines: [],
      tailLines: TRANSCRIPT,
      byteOffset: 0,
      totalSize: TRANSCRIPT.join("\n").length,
      hasMore: false,
    })
  }
  if (url.includes("/api/share/pending")) return json(pending)
  return json({ ok: true })
}

// Installed once for the file: an unmounting live session can open one after
// a test has already restored its own globals.
class InertEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage: unknown = null
  onerror: unknown = null
}
Object.defineProperty(globalThis, "EventSource", { value: InertEventSource, writable: true })

// jsdom has no layout, so everything the timeline lazy-loads is treated as visible.
class InertIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: InertIntersectionObserver,
  writable: true,
})

describe("SharedSessionView", () => {
  const pending = { permissions: [] as unknown[] }

  beforeEach(() => {
    // jsdom has no layout, so the chat scroller's calls are inert no-ops.
    Element.prototype.scrollIntoView = () => {}
    sessionCache.clear()
    __resetCapabilitiesForTest()
    pending.permissions = []
    vi.stubGlobal("fetch", vi.fn((url: RequestInfo | URL) => Promise.resolve(respond(String(url), pending))))
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetCapabilitiesForTest()
  })

  it("loads the transcript through the guest's own session path", async () => {
    render(<SharedSessionView info={INFO} />)

    expect(await screen.findByText("hi from the agent")).toBeInTheDocument()
    const load = findCall("/api/sessions/")
    expect(load?.url).toBe(
      "/api/sessions/-Users-me-proj/sess-1.jsonl?tail=30",
    )
  })

  it("shows the shared session's title and marks the view as a guest view", async () => {
    render(<SharedSessionView info={INFO} />)
    expect(await screen.findByRole("heading", { name: "Shared session" })).toBeInTheDocument()
    expect(screen.getByText("Guest view")).toBeInTheDocument()
  })

  it("revokes host capabilities so no guest control reaches a denied endpoint", async () => {
    render(<SharedSessionView info={INFO} />)
    await screen.findByTestId("timeline")
    expect(can("hostFiles")).toBe(false)
    expect(can("terminal")).toBe(false)
    expect(can("configWrite")).toBe(false)
  })

  it("sends a message through /api/share/send-message and names no session", async () => {
    render(<SharedSessionView info={INFO} />)
    await screen.findByTestId("timeline")

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "guest says hi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    await waitFor(() => expect(findCall("/api/share/send-message")).toBeDefined())
    const body = JSON.parse(findCall("/api/share/send-message")!.init!.body as string)
    expect(body).toEqual({ message: "guest says hi" })
    expect(body).not.toHaveProperty("sessionId")
    expect(body).not.toHaveProperty("cwd")
    expect(body).not.toHaveProperty("permissions")
    expect(body).not.toHaveProperty("mcpConfig")
  })

  it("renders a pending permission request and posts the decision", async () => {
    pending.permissions = [PERMISSION]
    render(<SharedSessionView info={INFO} />)

    const allow = await screen.findByTitle("Allow once (A)")
    fireEvent.click(allow)

    await waitFor(() => expect(findCall("/api/share/permission")).toBeDefined())
    expect(JSON.parse(findCall("/api/share/permission")!.init!.body as string)).toEqual({
      requestId: "req-1",
      behavior: "allow",
    })
  })

  it("never requests an endpoint a guest is denied", async () => {
    pending.permissions = [PERMISSION]
    render(<SharedSessionView info={INFO} />)
    await screen.findByTestId("timeline")
    await waitFor(() => expect(findCall("/api/share/pending")).toBeDefined())

    const denied = [
      "/api/projects",
      "/api/active-sessions",
      "/api/running-processes",
      "/api/config",
      "/api/permissions/",
      "/api/user-questions",
      "/api/undo-state",
      "/api/slash-suggestions",
      "/api/project-files",
    ]
    for (const path of denied) {
      expect(calls().filter((call) => call.url.includes(path))).toEqual([])
    }
  })

  it("reports a session that can no longer be read instead of spinning", async () => {
    vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) =>
      Promise.resolve(String(url).includes("/api/sessions/")
        ? json({ error: "Session not found" }, 404)
        : respond(String(url), pending)))

    render(<SharedSessionView info={INFO} />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not (be )?load/i)
  })
})
