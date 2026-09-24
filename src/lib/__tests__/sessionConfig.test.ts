import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), jsonFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, jsonFetch: mocks.jsonFetch }))

import { fetchSessionConfig, flushSessionConfig, getSessionConfigKey, saveSessionConfig } from "../sessionConfig"

describe("getSessionConfigKey", () => {
  it("preserves the historical Claude session key", () => {
    expect(getSessionConfigKey("session-123", "session-123.jsonl"))
      .toBe("session-123.jsonl")
  })

  it("uses a stable ID instead of a nested Codex rollout path", () => {
    expect(getSessionConfigKey(
      "019fed86-c462-7f02-8d0b-e41485ff40b9",
      "2026/08/10/rollout-2026-08-10T23-14-20-019fed86-c462-7f02-8d0b-e41485ff40b9.jsonl",
    )).toBe("019fed86-c462-7f02-8d0b-e41485ff40b9.jsonl")
  })

  it("falls back to the file name before session parsing finishes", () => {
    expect(getSessionConfigKey(null, "pending.jsonl")).toBe("pending.jsonl")
    expect(getSessionConfigKey(null, null)).toBeNull()
  })
})

describe("fetchSessionConfig", () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.authFetch.mockReset()
    mocks.jsonFetch.mockReset()
  })

  it("sends this client's waiting save of the session first, and reads once it is answered", async () => {
    vi.useFakeTimers()
    const order: string[] = []
    let answerSave!: () => void
    mocks.jsonFetch.mockImplementation((url: string, body: unknown) => {
      order.push(`PUT ${url} ${JSON.stringify(body)}`)
      return new Promise<Response>((resolve) => { answerSave = () => resolve(new Response("{}")) })
    })
    mocks.authFetch.mockImplementation(async (url: string) => {
      order.push(`GET ${url}`)
      return new Response(JSON.stringify({ permissionMode: "plan" }))
    })

    saveSessionConfig("a.jsonl", { permissionMode: "plan" })
    const read = fetchSessionConfig("a.jsonl")
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual([`PUT /api/session-config/a.jsonl {"permissionMode":"plan"}`])

    answerSave()
    await expect(read).resolves.toEqual({ permissionMode: "plan" })
    expect(order).toEqual([
      `PUT /api/session-config/a.jsonl {"permissionMode":"plan"}`,
      "GET /api/session-config/a.jsonl",
    ])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.jsonFetch).toHaveBeenCalledOnce()
  })

  it("reads another session without waiting on this one's save", async () => {
    vi.useFakeTimers()
    mocks.authFetch.mockResolvedValue(new Response("{}"))

    saveSessionConfig("a.jsonl", { effort: "low" })
    await expect(fetchSessionConfig("b.jsonl")).resolves.toEqual({})
    expect(mocks.jsonFetch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/session-config/a.jsonl", { effort: "low" }, { method: "PUT" })
  })
})

describe("saveSessionConfig", () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.jsonFetch.mockReset()
  })

  it("answers every save it merged with whether the server stored them", async () => {
    vi.useFakeTimers()
    mocks.jsonFetch.mockResolvedValue(new Response("{}"))

    const first = saveSessionConfig("a.jsonl", { model: "sonnet" })
    const second = saveSessionConfig("a.jsonl", { effort: "low" })
    await vi.advanceTimersByTimeAsync(300)

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(mocks.jsonFetch).toHaveBeenCalledOnce()
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/session-config/a.jsonl", { model: "sonnet", effort: "low" }, { method: "PUT" })
  })

  it("answers false for a save the server refused or never got", async () => {
    vi.useFakeTimers()
    mocks.jsonFetch.mockResolvedValueOnce(new Response("{}", { status: 403 })).mockRejectedValueOnce(new Error("offline"))

    const refused = saveSessionConfig("a.jsonl", { model: "sonnet" })
    await vi.advanceTimersByTimeAsync(300)
    const lost = saveSessionConfig("a.jsonl", { model: "haiku" })
    await vi.advanceTimersByTimeAsync(300)

    await expect(refused).resolves.toBe(false)
    await expect(lost).resolves.toBe(false)
  })
})

describe("flushSessionConfig", () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.jsonFetch.mockReset()
  })

  it("sends the key's waiting save now, and resolves once it is answered", async () => {
    vi.useFakeTimers()
    mocks.jsonFetch.mockResolvedValue(new Response("{}"))

    const saved = saveSessionConfig("a.jsonl", { model: "sonnet" })
    await flushSessionConfig("a.jsonl")

    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/session-config/a.jsonl", { model: "sonnet" }, { method: "PUT" })
    await expect(saved).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.jsonFetch).toHaveBeenCalledOnce()
  })

  it("sends nothing for a key with no save waiting", async () => {
    await flushSessionConfig("a.jsonl")

    expect(mocks.jsonFetch).not.toHaveBeenCalled()
  })
})
