// @vitest-environment node
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { parseBrowserRequest, requestInBrowser } from "../../browser/request"

const url = "https://example.com/api"

function fixture(options: { response?: Response; targets?: { targetId: string; type: string; url: string }[]; origin?: string } = {}) {
  const fetch = vi.fn(async () => options.response ?? new Response("data", { headers: { "content-type": "text/plain" } }))
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Target.getTargets") return { targetInfos: options.targets ?? [{ targetId: "tab-1", type: "page", url: "https://example.com/start" }] }
    if (method === "Target.attachToTarget") return { sessionId: "session-1" }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 }
    if (method === "Runtime.evaluate") return { result: { value: await runInNewContext(params.expression as string, {
      location: { origin: options.origin ?? "https://example.com" }, URL, AbortController, TextDecoder, setTimeout, clearTimeout, fetch,
    }) } }
    throw new Error(`Unexpected CDP command: ${method}`)
  })
  const close = vi.fn()
  const deps = {
    isRunning: vi.fn(async () => true),
    endpoint: vi.fn(() => ({ browserWsUrl: "ws://127.0.0.1:1234/browser", port: 1234 })),
    connect: vi.fn(async () => ({ send: send as never, close })),
  }
  return { deps, send, close, fetch }
}

describe("browser requests", () => {
  it("uses the selected browser's native fetch without navigating or exporting cookies", async () => {
    const f = fixture()
    const result = await requestInBrowser("work", { url }, f.deps)
    expect(result).toMatchObject({ browser: "work", targetId: "tab-1", state: "complete", status: 200, body: "data", truncated: false })
    expect(f.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "same-origin", mode: "same-origin", redirect: "manual", cache: "no-store", method: "GET" }))
    expect(f.send.mock.calls.map(([method]) => method)).toEqual([
      "Target.getTargets", "Target.attachToTarget", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate",
    ])
    expect(f.close).toHaveBeenCalledOnce()
  })

  it("recognizes Cloudflare's challenge header without retrying it", async () => {
    const f = fixture({ response: new Response("verify", { status: 403, headers: { "cf-mitigated": "challenge" } }) })
    expect(await requestInBrowser("work", { url }, f.deps)).toMatchObject({ state: "challenge-required", status: 403 })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it.each(["failed", "stalled"])("hands off immediately even when the challenge body is %s", async (kind) => {
    const stream = new ReadableStream({ start(controller) {
      if (kind === "failed") controller.error(new Error("Body download failed"))
    } })
    const f = fixture({ response: new Response(stream, { status: 403, headers: { "cf-mitigated": "challenge" } }) })
    expect(await requestInBrowser("work", { url }, f.deps)).toMatchObject({ state: "challenge-required", status: 403, body: "" })
    const [, options] = f.fetch.mock.calls[0] as unknown as [string, { signal: AbortSignal }]
    expect(options.signal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
  })

  it("preserves ordinary error responses without labelling them a CAPTCHA", async () => {
    const f = fixture({ response: new Response("forbidden", { status: 403 }) })
    expect(await requestInBrowser("work", { url }, f.deps)).toMatchObject({ state: "complete", status: 403, body: "forbidden" })
  })

  it("returns redirects for navigation instead of following them to another origin", async () => {
    const response = new Response(null)
    Object.defineProperties(response, { type: { value: "opaqueredirect" }, status: { value: 0 } })
    const f = fixture({ response })
    expect(await requestInBrowser("work", { url }, f.deps)).toMatchObject({ state: "navigation-required", status: 0 })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it("bounds response size and reports truncation", async () => {
    const f = fixture({ response: new Response("a".repeat(2 * 1024 * 1024 + 1)) })
    const result = await requestInBrowser("work", { url }, f.deps)
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBe(2 * 1024 * 1024)
  })

  it("does not truncate a response exactly at the limit", async () => {
    const f = fixture({ response: new Response("a".repeat(2 * 1024 * 1024)) })
    expect((await requestInBrowser("work", { url }, f.deps)).truncated).toBe(false)
  })

  it("supports HEAD with no body", async () => {
    const f = fixture({ response: new Response(null, { status: 204 }) })
    expect(await requestInBrowser("work", { url, method: "HEAD" }, f.deps)).toMatchObject({ status: 204, body: "" })
    expect(f.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "HEAD" }))
  })

  it("requires an explicit choice when several tabs share the origin", async () => {
    const f = fixture({ targets: ["tab-1", "tab-2"].map((targetId) => ({ targetId, type: "page", url })) })
    await expect(requestInBrowser("work", { url }, f.deps)).rejects.toThrow("Supply targetId")
    expect(f.fetch).not.toHaveBeenCalled()
    expect(await requestInBrowser("work", { url, targetId: "tab-2" }, f.deps)).toMatchObject({ targetId: "tab-2" })
  })

  it("refuses a different origin, even when its tab ID was explicitly requested", async () => {
    const f = fixture({ targets: [{ targetId: "tab-1", type: "page", url: "https://other.example/" }] })
    await expect(requestInBrowser("work", { url, targetId: "tab-1" }, f.deps)).rejects.toThrow("complete any human verification")
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it("rechecks origin inside the page if it navigated during attachment", async () => {
    const f = fixture({ origin: "https://other.example" })
    await expect(requestInBrowser("work", { url }, f.deps)).rejects.toThrow("changed origin")
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it("does not launch stopped browsers or share throwaway profiles", async () => {
    const f = fixture()
    f.deps.isRunning.mockResolvedValue(false)
    await expect(requestInBrowser("work", { url }, f.deps)).rejects.toThrow("Open the work browser first")
    await expect(requestInBrowser("tmp-agent", { url }, f.deps)).rejects.toThrow("throwaway")
    expect(f.deps.connect).not.toHaveBeenCalled()
  })

  it("closes the connection on a browser error", async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(new Error("Tab closed"))
    await expect(requestInBrowser("work", { url }, f.deps)).rejects.toThrow("Tab closed")
    expect(f.close).toHaveBeenCalledOnce()
  })

  it("aborts slow requests and releases the connection", async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.fetch.mockImplementation((_url?: unknown, options?: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options?.signal.addEventListener("abort", () => reject(new Error("aborted")))
      }))
      const pending = expect(requestInBrowser("work", { url }, f.deps)).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(8000)
      await pending
      expect(f.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("request validation", () => {
  it("normalizes URLs and discards fragments", () => {
    expect(parseBrowserRequest({ url: "https://example.com#section" })).toMatchObject({ url: "https://example.com/", method: "GET" })
  })

  it.each([{}, { url: "/relative" }, { url: "file:///secret" }, { url: "https://u:p@example.com" },
    { url, method: "POST" }, { url, targetId: "" }, { url, body: "ignored?" }])("rejects unsafe or unsupported input: %j", (input) => {
    expect(() => parseBrowserRequest(input)).toThrow()
  })
})
