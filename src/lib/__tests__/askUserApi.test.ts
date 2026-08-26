import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { joinMultiSelect, submitUserQuestionAnswers } from "@/lib/askUserApi"

function ok(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response
}

function lastCall(): [string, RequestInit] {
  const calls = vi.mocked(fetch).mock.calls
  const [url, init] = calls[calls.length - 1]
  return [String(url), init as RequestInit]
}

describe("submitUserQuestionAnswers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()))
    history.pushState({}, "", "/")
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    history.pushState({}, "", "/")
  })

  it("names the session on the host route", async () => {
    await submitUserQuestionAnswers("sess-1", "tu-1", { "Pick one": "a" })
    const [url, init] = lastCall()
    expect(url).toBe("/api/ask-user-answer")
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "sess-1",
      toolUseId: "tu-1",
      answers: { "Pick one": "a" },
    })
  })

  it("uses the token-scoped route and names no session when the page is a share", async () => {
    history.pushState({}, "", "/shared/sess-1")
    await submitUserQuestionAnswers("sess-1", "tu-1", { "Pick one": "a" })
    const [url, init] = lastCall()
    expect(url).toBe("/api/share/answer")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ toolUseId: "tu-1", answers: { "Pick one": "a" } })
    expect(body).not.toHaveProperty("sessionId")
  })

  it("reports a 404 as gone on either route", async () => {
    vi.mocked(fetch).mockResolvedValue(ok(404))
    expect(await submitUserQuestionAnswers("s", "t", {})).toEqual({ ok: false, gone: true })
    history.pushState({}, "", "/shared/s")
    expect(await submitUserQuestionAnswers("s", "t", {})).toEqual({ ok: false, gone: true })
  })

  it("resolves rather than throwing when the request fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"))
    expect(await submitUserQuestionAnswers("s", "t", {})).toEqual({ ok: false, gone: false })
  })
})

describe("joinMultiSelect", () => {
  it("joins on the separator AskUserAnswerForm splits on", () => {
    expect(joinMultiSelect(["a", "b"])).toBe("a, b")
  })
})
