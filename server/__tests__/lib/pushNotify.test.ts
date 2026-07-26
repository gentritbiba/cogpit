// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { buildNtfyPayload, sendPushNotification } from "../../lib/pushNotify"
import type { PushConfig } from "../../lib/pushConfig"

const CONFIG: PushConfig = { ntfyUrl: "https://ntfy.sh", topic: "cogpit-secret" }
const WITH_PUBLIC: PushConfig = { ...CONFIG, publicUrl: "https://mb.cogpit.dev" }
const NAV = { sessionId: "abc-123", dirName: "-Users-me-proj" }

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("buildNtfyPayload", () => {
  it("carries title, message and topic", () => {
    const payload = buildNtfyPayload({ title: "Claude Code — proj", body: "Done", nav: NAV }, CONFIG)
    expect(payload).toMatchObject({
      topic: "cogpit-secret",
      title: "Claude Code — proj",
      message: "Done",
    })
  })

  it("adds a click deep-link when a public url is configured", () => {
    const payload = buildNtfyPayload({ title: "t", body: "b", nav: NAV }, WITH_PUBLIC)
    expect(payload.click).toBe("https://mb.cogpit.dev/-Users-me-proj/abc-123")
  })

  it("omits click without a public url, rather than pointing at 127.0.0.1", () => {
    expect(buildNtfyPayload({ title: "t", body: "b", nav: NAV }, CONFIG).click).toBeUndefined()
  })

  it("omits click when there is no session to link to", () => {
    const payload = buildNtfyPayload(
      { title: "Cogpit", body: "Cleaned up 2 leaked processes", nav: { sessionId: null, dirName: null } },
      WITH_PUBLIC,
    )
    expect(payload.click).toBeUndefined()
  })

  it("percent-encodes a Codex rollout path in the click url", () => {
    const payload = buildNtfyPayload(
      { title: "t", body: "b", nav: { dirName: "codex__abc", sessionId: "2026/07/25/rollout-x" } },
      WITH_PUBLIC,
    )
    expect(payload.click).toBe("https://mb.cogpit.dev/codex__abc/2026%2F07%2F25%2Frollout-x")
  })

  it("preserves non-ASCII intact — the reason we publish JSON, not headers", () => {
    const payload = buildNtfyPayload({ title: "プロジェクト", body: "完了しました 🎉", nav: NAV }, CONFIG)
    expect(payload.title).toBe("プロジェクト")
    expect(payload.message).toBe("完了しました 🎉")
    expect(JSON.parse(JSON.stringify(payload)).message).toBe("完了しました 🎉")
  })

  it("substitutes a fallback when title or body is empty", () => {
    const payload = buildNtfyPayload({ title: "", body: "", nav: NAV }, CONFIG)
    expect(payload.title).toBe("Cogpit")
    expect(payload.message).toBe("Needs your attention")
  })

  it("strips control characters and newlines", () => {
    const payload = buildNtfyPayload({ title: "a\u0000b", body: "one\ntwo\ttail", nav: NAV }, CONFIG)
    expect(payload.title).toBe("a b")
    expect(payload.message).toBe("one two tail")
  })

  it("keeps the message under ntfy's size limit", () => {
    const payload = buildNtfyPayload({ title: "t", body: "x".repeat(5000), nav: NAV }, CONFIG)
    expect(new TextEncoder().encode(payload.message).length).toBeLessThanOrEqual(1024)
    expect(payload.message.endsWith("…")).toBe(true)
  })

  it("truncates multi-byte text on code-point boundaries", () => {
    const payload = buildNtfyPayload({ title: "t", body: "字".repeat(2000), nav: NAV }, CONFIG)
    const bytes = new TextEncoder().encode(payload.message)
    expect(bytes.length).toBeLessThanOrEqual(1024)
    // A split 3-byte sequence would decode to U+FFFD.
    expect(payload.message).not.toContain("�")
  })

  it("does not split an emoji surrogate pair", () => {
    const payload = buildNtfyPayload({ title: "t", body: "🎉".repeat(1000), nav: NAV }, CONFIG)
    expect(payload.message).not.toContain("�")
    expect(/[\uD800-\uDFFF]/.test(payload.message.replace(/[\u{1F300}-\u{1FAFF}]/gu, ""))).toBe(false)
  })
})

describe("sendPushNotification", () => {
  const notification = { title: "t", body: "b", nav: NAV }

  it("does nothing when push is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await expect(sendPushNotification(notification, null)).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("POSTs JSON to the ntfy ROOT url, not the topic url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }))

    await expect(sendPushNotification(notification, CONFIG)).resolves.toBe(true)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://ntfy.sh")
    expect(url).not.toContain("cogpit-secret")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string).topic).toBe("cogpit-secret")
  })

  it("sends a bearer token only when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }))

    await sendPushNotification(notification, CONFIG)
    expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined()

    await sendPushNotification(notification, { ...CONFIG, token: "tk_1" })
    expect((fetchSpy.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tk_1")
  })

  it("reports failure without throwing on a 4xx/5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }))
    await expect(sendPushNotification(notification, CONFIG)).resolves.toBe(false)
  })

  it("swallows a network error so the agent turn is unaffected", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND ntfy.sh"))
    await expect(sendPushNotification(notification, CONFIG)).resolves.toBe(false)
  })

  it("swallows a timeout abort", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    )
    await expect(sendPushNotification(notification, CONFIG)).resolves.toBe(false)
  })

  it("passes an abort signal so a hung server cannot wedge delivery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }))
    await sendPushNotification(notification, CONFIG)
    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it("refuses to follow redirects, so the topic secret cannot be leaked onward", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }))
    await sendPushNotification(notification, CONFIG)
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe("error")
  })
})
