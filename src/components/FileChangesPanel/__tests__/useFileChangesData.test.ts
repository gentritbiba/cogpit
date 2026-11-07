import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseSession } from "../../../../shared/session/parser"
import { toSessionView } from "../../../../shared/session/sessionDigest"
import { makeEditToolCall, simpleSession } from "@/__tests__/fixtures"

const api = vi.hoisted(() => ({ fetch: vi.fn(), source: { dirName: "project", watchOffset: 7, loadId: 1 } }))
vi.mock("@/lib/auth", () => ({ authFetch: api.fetch }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContext: () => ({ sessionSource: api.source }) }))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/lib/device", () => ({ deviceScopedKey: (key: string) => key }))
import { useFileChangesData } from "../useFileChangesData"

afterEach(() => { api.fetch.mockReset(); api.source.loadId = 1 })
describe("useFileChangesData", () => {
  it("reuses unchanged file contents, refreshes edited files, and reloads on focus or explicit session reload", async () => {
    const session = toSessionView(parseSession(simpleSession()))
    const firstEdit = makeEditToolCall("/project/a.ts", "old", "new")
    const secondEdit = makeEditToolCall("/project/b.ts", "old", "new")
    session.turns[0].toolCalls = [firstEdit, secondEdit]
    api.fetch.mockImplementation(async () => new Response("file content"))
    const { result, rerender, unmount } = renderHook(({ value }) => useFileChangesData(value), { initialProps: { value: session } })
    await act(async () => {})
    expect(api.fetch).toHaveBeenCalledTimes(2)
    const contents = result.current.fileContents
    const next = structuredClone(session)
    next.turns[0].assistantText.push("unrelated streaming text")
    rerender({ value: next })
    await act(async () => {})
    expect(api.fetch).toHaveBeenCalledTimes(2)
    expect(result.current.fileContents).toBe(contents)
    next.turns[0].toolCalls = [...next.turns[0].toolCalls, makeEditToolCall("/project/a.ts", "new", "newer")]
    rerender({ value: { ...next, turns: [...next.turns] } })
    await act(async () => {})
    expect(api.fetch).toHaveBeenCalledTimes(3)
    expect(api.fetch.mock.calls.at(-1)?.[0]).toContain(encodeURIComponent("/project/a.ts"))
    await act(async () => { window.dispatchEvent(new Event("focus")) })
    expect(api.fetch).toHaveBeenCalledTimes(5)
    api.source.loadId = 2
    rerender({ value: { ...next } })
    await act(async () => {})
    expect(api.fetch).toHaveBeenCalledTimes(7)
    unmount()
  })

  it("accepts empty files and drops responses from the previous session", async () => {
    const session = toSessionView(parseSession(simpleSession()))
    session.turns[0].toolCalls = [makeEditToolCall("/project/a.ts", "old", "new")]
    let finish!: (response: Response) => void
    api.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    api.fetch.mockResolvedValue(new Response(""))
    const { result, rerender } = renderHook(({ value }) => useFileChangesData(value), { initialProps: { value: session } })
    rerender({ value: { ...session, sessionId: "another" } })
    await act(async () => { finish(new Response("stale")) })
    expect(result.current.fileContents.get("/project/a.ts")).toBe("")
  })
})
