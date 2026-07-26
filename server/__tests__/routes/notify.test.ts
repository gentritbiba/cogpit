// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockDeliver = vi.fn()
vi.mock("../../lib/notificationDelivery", () => ({
  deliverNotification: (notification: { title: string; body: string; nav: unknown }) =>
    mockDeliver(notification.title, notification.body, notification.nav),
}))

// Keeps the existing (title, body, nav) assertions readable.
const mockShowNotification = mockDeliver

import { registerNotifyRoutes } from "../../routes/notify"
import type { Middleware, UseFn } from "../../helpers"

function buildHandler(): Middleware {
  let captured: Middleware | undefined
  const use: UseFn = (_path, handler) => { captured = handler }
  registerNotifyRoutes(use)
  if (!captured) throw new Error("registerNotifyRoutes did not call use()")
  return captured
}

/** Drive the handler through a full request and return the JSON response. */
async function post(body: unknown, method = "POST") {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {}

  const req = {
    method,
    url: "/api/notify",
    on(event: string, cb: (chunk?: unknown) => void) {
      ;(listeners[event] ??= []).push(cb)
      return req
    },
  }

  let statusCode = 200
  let responseBody = ""
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { responseBody = data || "" }),
  }

  const next = vi.fn()
  const pending = handler(
    req as unknown as Parameters<Middleware>[0],
    res as unknown as Parameters<Middleware>[1],
    next,
  )

  // Stream the body as a Buffer, the way Node actually delivers it.
  for (const cb of listeners.data ?? []) cb(Buffer.from(raw))
  for (const cb of listeners.end ?? []) cb()
  await pending

  return {
    status: statusCode,
    json: responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : null,
    next,
  }
}

let handler: Middleware

// Unique ids keep the module-level per-session cooldown from leaking between tests.
let idCounter = 0
const freshId = () => `session-${++idCounter}`

beforeEach(() => {
  mockShowNotification.mockReset()
  handler = buildHandler()
})

describe("POST /api/notify — Claude Code hooks", () => {
  it("titles by project and deep-links using the transcript directory", async () => {
    const sessionId = freshId()
    const res = await post({
      session_id: sessionId,
      cwd: "/Users/me/code/agent-window",
      transcript_path: `/Users/me/.claude/projects/-Users-me-code-agent-window/${sessionId}.jsonl`,
      hook_event_name: "Stop",
      last_assistant_message: "Done with the refactor",
    })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({ success: true })
    expect(mockShowNotification).toHaveBeenCalledWith(
      "Claude Code — agent-window",
      "Done with the refactor",
      { sessionId, dirName: "-Users-me-code-agent-window" },
    )
  })

  it("falls back to an event-specific body when there is no assistant message", async () => {
    await post({ session_id: freshId(), cwd: "/Users/me/proj", hook_event_name: "Stop" })
    expect(mockShowNotification).toHaveBeenCalledWith(
      "Claude Code — proj",
      "Waiting for your input",
      expect.anything(),
    )

    await post({ session_id: freshId(), cwd: "/Users/me/proj", hook_event_name: "Notification" })
    expect(mockShowNotification).toHaveBeenLastCalledWith(
      "Claude Code — proj",
      "Needs your attention",
      expect.anything(),
    )
  })

  it("strips markdown and truncates a long assistant message", async () => {
    await post({
      session_id: freshId(),
      cwd: "/Users/me/proj",
      last_assistant_message: `**Bold** and \`code\`\n\n${"x".repeat(300)}`,
    })

    const [, body] = mockShowNotification.mock.calls[0]
    expect(body).toHaveLength(120)
    expect(body.endsWith("…")).toBe(true)
    expect(body).not.toContain("*")
    expect(body).not.toContain("`")
  })

  it("skips subagent transcripts", async () => {
    const res = await post({
      session_id: freshId(),
      transcript_path: "/Users/me/.claude/projects/-p/parent/subagents/agent-1.jsonl",
    })
    expect(res.json).toEqual({ success: true, skipped: "subagent" })
    expect(mockShowNotification).not.toHaveBeenCalled()
  })
})

describe("POST /api/notify — Codex notify", () => {
  it("maps an agent-turn-complete payload to a Codex deep link", async () => {
    const res = await post({
      type: "agent-turn-complete",
      "thread-id": "019f9931-8d56-7431-85e0-ea2454609294",
      "turn-id": "019f9931-8dbd-7940-a6ee-8f78c59d053f",
      cwd: "/Users/me/code/agent-window",
      "input-messages": ["ship it"],
      "last-assistant-message": "Shipped",
    })

    expect(res.status).toBe(200)
    const [title, body, nav] = mockShowNotification.mock.calls[0]
    expect(title).toBe("Codex — agent-window")
    expect(body).toBe("Shipped")
    expect(nav.sessionId).toBe("019f9931-8d56-7431-85e0-ea2454609294")
    // codex__ + url-safe base64 of the cwd
    expect(nav.dirName).toMatch(/^codex__/)
  })

  it("handles a null last-assistant-message", async () => {
    await post({
      type: "agent-turn-complete",
      "thread-id": freshId(),
      cwd: "/Users/me/proj",
      "last-assistant-message": null,
    })
    expect(mockShowNotification).toHaveBeenCalledWith("Codex — proj", "Turn complete", expect.anything())
  })

  it("is detected by thread-id even without the type tag", async () => {
    await post({ "thread-id": freshId(), cwd: "/Users/me/proj" })
    const [title] = mockShowNotification.mock.calls[0]
    expect(title).toBe("Codex — proj")
  })
})

describe("POST /api/notify — throttling", () => {
  it("suppresses a repeat for the same session inside the cooldown", async () => {
    const session_id = freshId()
    await post({ session_id, cwd: "/Users/me/proj" })
    const second = await post({ session_id, cwd: "/Users/me/proj" })

    expect(second.json).toEqual({ success: true, throttled: true })
    expect(mockShowNotification).toHaveBeenCalledTimes(1)
  })

  it("does not let one session's cooldown suppress another's", async () => {
    await post({ session_id: freshId(), cwd: "/Users/me/a" })
    await post({ session_id: freshId(), cwd: "/Users/me/b" })
    await post({ session_id: freshId(), cwd: "/Users/me/c" })

    expect(mockShowNotification).toHaveBeenCalledTimes(3)
  })

  it("throttles a Codex thread independently of a Claude session", async () => {
    const id = freshId()
    await post({ session_id: id, cwd: "/Users/me/proj" })
    await post({ type: "agent-turn-complete", "thread-id": id, cwd: "/Users/me/proj" })

    expect(mockShowNotification).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/notify — protocol", () => {
  it("passes non-POST requests through", async () => {
    const res = await post({}, "GET")
    expect(res.next).toHaveBeenCalled()
    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it("rejects a malformed body", async () => {
    const res = await post("{not json", "POST")
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: "Invalid JSON body" })
    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it("honours explicit title and body overrides", async () => {
    await post({ session_id: freshId(), title: "Custom", body: "Override", cwd: "/Users/me/proj" })
    expect(mockShowNotification).toHaveBeenCalledWith("Custom", "Override", expect.anything())
  })

  it("sanitizes an override body too, not just the hook-derived one", async () => {
    await post({ session_id: freshId(), body: `**bold**\n\n${"y".repeat(300)}`, cwd: "/Users/me/proj" })
    const [, body] = mockShowNotification.mock.calls[0]
    expect(body).toHaveLength(120)
    expect(body).not.toContain("*")
  })

  it("accepts a Codex payload far larger than the 64 KB default body cap", async () => {
    // input-messages carries the whole prompt, so long turns exceed 64 KB —
    // exactly the turns most worth announcing.
    const res = await post({
      type: "agent-turn-complete",
      "thread-id": freshId(),
      cwd: "/Users/me/proj",
      "input-messages": ["z".repeat(200_000)],
      "last-assistant-message": "Finished the big refactor",
    })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({ success: true })
    expect(mockShowNotification).toHaveBeenCalledWith(
      "Codex — proj",
      "Finished the big refactor",
      expect.anything(),
    )
  })

  it("reports a too-large body as 413 rather than mislabelling it invalid JSON", async () => {
    const res = await post({ session_id: freshId(), cwd: "/Users/me/proj", pad: "q".repeat(5_000_000) })
    expect(res.status).toBe(413)
    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it("notifies for Cogpit-spawned sessions — presence decides, not provenance", async () => {
    // These used to be filtered out, which meant anyone working inside Cogpit
    // was never notified at all.
    await post({ session_id: freshId(), cwd: "/Users/me/proj", hook_event_name: "Stop" })
    expect(mockShowNotification).toHaveBeenCalledOnce()
  })

  it("rejects a JSON array body", async () => {
    const res = await post([1, 2, 3])
    expect(res.status).toBe(400)
    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it("survives a multi-byte character split across chunks", async () => {
    const sessionId = freshId()
    const raw = JSON.stringify({ session_id: sessionId, cwd: "/Users/me/proj", last_assistant_message: "完了しました" })
    const buf = Buffer.from(raw)

    const listeners: Record<string, Array<(chunk?: unknown) => void>> = {}
    const req = {
      method: "POST",
      url: "/api/notify",
      on(event: string, cb: (chunk?: unknown) => void) {
        ;(listeners[event] ??= []).push(cb)
        return req
      },
    }
    let statusCode = 200
    let responseBody = ""
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      setHeader: vi.fn(),
      end: vi.fn((data?: string) => { responseBody = data || "" }),
    }

    const pending = handler(
      req as unknown as Parameters<Middleware>[0],
      res as unknown as Parameters<Middleware>[1],
      vi.fn(),
    )
    // Split mid-character: the body contains 3-byte UTF-8 sequences.
    const cut = raw.indexOf("完") + 1
    for (const cb of listeners.data ?? []) cb(buf.subarray(0, cut))
    for (const cb of listeners.data ?? []) cb(buf.subarray(cut))
    for (const cb of listeners.end ?? []) cb()
    await pending

    expect(statusCode).toBe(200)
    expect(JSON.parse(responseBody)).toEqual({ success: true })
    expect(mockShowNotification).toHaveBeenCalledWith(expect.anything(), "完了しました", expect.anything())
  })
})
