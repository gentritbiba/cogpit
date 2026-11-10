// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { reconcileStore } from "../../../shared/memory/reconcile"
import type { MemoryStore } from "../../../shared/memory/store"
import type { SubAgentMessage } from "../../../shared/session/types"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function open(): MemoryStore {
  const store = openMemoryStore()
  stores.push(store)
  return store
}

const inline = (agentId: string, text: string): SubAgentMessage => ({
  agentId, agentName: null, subagentType: null, type: "assistant", content: null, toolCalls: [], thinking: [], text: [text],
  timestamp: "2026-11-01T10:00:00.000Z", tokenUsage: null, model: null, isBackground: false,
})

describe("reconcileStore", () => {
  it("syncs stale files newest first, pausing between them, and skips unchanged ones next time", async () => {
    const store = open()
    const files = [sourceFile({ path: "/t/old.jsonl", mtimeMs: 1 }), sourceFile({ path: "/t/new.jsonl", mtimeMs: 2, sessionId: "session-2" })]
    const parsed: string[] = []
    let pauses = 0
    const io = {
      parse: (file: { path: string }) => {
        parsed.push(file.path)
        return makeSession([{ user: `prompt in ${file.path}` }])
      },
      title: () => "Given title",
      pause: async () => { pauses++ },
    }
    expect(await reconcileStore(store, files, io)).toMatchObject({ files: 2, stale: 2, synced: 2, failed: 0, pending: 0, chunks: { added: 2 } })
    expect(parsed).toEqual(["/t/new.jsonl", "/t/old.jsonl"])
    expect(pauses).toBe(2)
    expect(store.db.prepare("SELECT DISTINCT title FROM sessions").all()).toEqual([expect.objectContaining({ title: "Given title" })])
    expect(await reconcileStore(store, files, io)).toMatchObject({ stale: 0, synced: 0 })
  })

  it("leaves files for later when the budget is spent or the run is aborted, and counts failures", async () => {
    const store = open()
    const files = [sourceFile({ path: "/t/a.jsonl" }), sourceFile({ path: "/t/b.jsonl", sessionId: "s-b" })]
    const controller = new AbortController()
    controller.abort()
    expect(await reconcileStore(store, files, { parse: () => makeSession([]) }, { signal: controller.signal })).toMatchObject({ synced: 0, pending: 2 })
    expect(await reconcileStore(store, files, { parse: () => makeSession([]) }, { budgetMs: -1 })).toMatchObject({ synced: 0, pending: 2 })
    expect(await reconcileStore(store, files, { parse: () => { throw new Error("unreadable") } })).toMatchObject({ synced: 0, failed: 2 })
  })

  it("indexes a subagent's text from its own transcript, not again from its parent's report", async () => {
    const store = open()
    const parent = sourceFile()
    const child = sourceFile({ path: "/t/session-1/subagents/agent-a1.jsonl", isSubagent: true, parentSessionId: "session-1", agentId: "a1" })
    await reconcileStore(store, [parent, child], {
      parse: (file) => file.isSubagent
        ? makeSession([{ assistant: "found it" }])
        : makeSession([{ user: "go", blocks: [{ kind: "sub_agent", messages: [inline("a1", "found it"), inline("b2", "inline only")] }] }]),
    })
    expect(store.db.prepare("SELECT text, agent_id, inline_agent_id FROM chunks WHERE kind = 'assistant' ORDER BY text").all()).toEqual([
      expect.objectContaining({ text: "found it", agent_id: "a1", inline_agent_id: null }),
      expect.objectContaining({ text: "inline only", agent_id: null, inline_agent_id: "b2" }),
    ])
  })
})
