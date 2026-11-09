import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseSession } from "../../../../shared/session/parser"
import { toSessionView } from "../../../../shared/session/sessionDigest"
import { makeEditToolCall, simpleSession } from "@/__tests__/fixtures"
import type { SessionView } from "../../../../shared/session/sessionDigest"
import type { SubAgentMessage } from "../../../../shared/session/types"

const api = vi.hoisted(() => ({ fetch: vi.fn(), source: { dirName: "project", watchOffset: 7, loadId: 1 } }))
vi.mock("@/lib/auth", () => ({ authFetch: api.fetch }))
vi.mock("@/contexts/SessionContext", async () => (await import("@/__tests__/sessionContextMock")).withSessionHooks({ useSessionContext: () => ({ sessionSource: api.source }) }))
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

  describe("background agents", () => {
    const agentEdit = (file: string) => JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-09T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: `edit-${file}`, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] },
    })
    const progress = (agentId: string, second: number): SubAgentMessage => ({
      agentId, agentName: "worker", subagentType: null, type: "assistant", content: "", toolCalls: [], thinking: [], text: [],
      timestamp: `2026-11-09T10:00:${String(second).padStart(2, "0")}.000Z`, tokenUsage: null, model: null, isBackground: true,
    })
    const withProgress = (base: SessionView, seconds: number[]): SessionView => {
      const turns = [...base.turns]
      turns[0] = { ...turns[0], subAgentActivity: seconds.map((second) => progress("bg1", second)) }
      return { ...base, turns }
    }
    const agentReads = () => api.fetch.mock.calls.filter(([url]) => String(url).includes("/subagents/agent-bg1.jsonl"))
    let session: SessionView
    let agentId = 0

    beforeEach(() => {
      // The transcript cache is module-wide, so each test watches a session of its own.
      session = { ...toSessionView(parseSession(simpleSession())), sessionId: `bg-session-${++agentId}` }
    })

    it("reads an agent's transcript once however many progress messages it left, sharing the read in flight", async () => {
      let finish!: (response: Response) => void
      api.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
      const seconds = Array.from({ length: 50 }, (_, index) => index)
      const { result, rerender } = renderHook(({ value }) => useFileChangesData(value), { initialProps: { value: withProgress(session, seconds) } })
      rerender({ value: withProgress(session, seconds) })
      rerender({ value: withProgress(session, seconds) })
      expect(agentReads()).toHaveLength(1)

      await act(async () => { finish(new Response(agentEdit("/project/c.ts"))) })
      expect(result.current.fileChanges.map((change) => [change.agentId, change.toolCall.input.file_path])).toEqual([["bg1", "/project/c.ts"]])
      rerender({ value: withProgress(session, seconds) })
      await act(async () => {})
      expect(agentReads()).toHaveLength(1)
    })

    it("reads the transcript again only after the agent wrote more, once however often it moved meanwhile", async () => {
      api.fetch.mockResolvedValueOnce(new Response(agentEdit("/project/c.ts")))
      const { result, rerender } = renderHook(({ value }) => useFileChangesData(value), { initialProps: { value: withProgress(session, [1, 2]) } })
      await act(async () => {})
      expect(agentReads()).toHaveLength(1)

      let finish!: (response: Response) => void
      api.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
      api.fetch.mockResolvedValue(new Response(agentEdit("/project/e.ts")))
      rerender({ value: withProgress(session, [1, 2, 3]) })
      rerender({ value: withProgress(session, [1, 2, 3, 4]) })
      rerender({ value: withProgress(session, [1, 2, 3, 4, 5]) })
      expect(agentReads()).toHaveLength(2)

      await act(async () => { finish(new Response(agentEdit("/project/d.ts"))) })
      await act(async () => {})
      expect(agentReads()).toHaveLength(3)
      expect(result.current.fileChanges.map((change) => change.toolCall.input.file_path)).toEqual(["/project/e.ts"])
      rerender({ value: withProgress(session, [1, 2, 3, 4, 5]) })
      await act(async () => {})
      expect(agentReads()).toHaveLength(3)
    })
  })
})
