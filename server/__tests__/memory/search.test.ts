// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { collapseDuplicates, rrfScore, RRF_K } from "../../../shared/memory/fusion"
import { countTermMatches, ftsQuery } from "../../../shared/memory/keywordSearch"
import { memoryDatabasePath, resolveMemoryDir } from "../../../shared/memory/paths"
import { chunkLocation, clampSearchLimit, searchProse } from "../../../shared/memory/search"
import type { MemoryStore } from "../../../shared/memory/store"
import { makeSession, openMemoryStore, sourceFile } from "./helpers"

const stores: MemoryStore[] = []

function open(): MemoryStore {
  const store = openMemoryStore()
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe("ftsQuery", () => {
  it("ORs the meaningful words and drops stopwords", () => {
    expect(ftsQuery("why did we change the Authentication flow?")).toEqual({
      match: '"change" OR "authentication" OR "flow"',
      terms: ["change", "authentication", "flow"],
    })
  })

  it("keeps quoted phrases and escapes FTS syntax", () => {
    expect(ftsQuery('"exact words" NEAR AND x"y')?.match).toBe('"exact words" OR "near" OR "x""y"')
  })

  it("keeps stopwords when nothing else is left, and gives up on punctuation", () => {
    expect(ftsQuery("what is it")?.terms).toEqual(["what", "is", "it"])
    expect(ftsQuery("?? !!")).toBeNull()
  })

  it("counts occurrences of every term", () => {
    expect(countTermMatches("Auth fails; auth again. Flow ok", ["auth", "flow"])).toBe(3)
  })
})

describe("fusion", () => {
  it("adds 1/(k+rank) for every list an item appears in", () => {
    expect(rrfScore([1, undefined, 3])).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 3))
  })

  it("keeps the first of each duplicate and counts the rest", () => {
    const items = [{ id: 1, text: "a", duplicates: 0 }, { id: 2, text: "b", duplicates: 0 }, { id: 3, text: "a", duplicates: 0 }]
    expect(collapseDuplicates(items, (item) => item.text)).toEqual([{ id: 1, text: "a", duplicates: 1 }, { id: 2, text: "b", duplicates: 0 }])
  })
})

describe("paths", () => {
  it("prefers COGPIT_MEMORY_DIR and falls back to ~/.cogpit/memory", () => {
    expect(resolveMemoryDir({ COGPIT_MEMORY_DIR: "/tmp/m" }, "/home/me")).toBe("/tmp/m")
    expect(resolveMemoryDir({ COGPIT_MEMORY_DIR: " " }, "/home/me/")).toBe("/home/me/.cogpit/memory")
    expect(resolveMemoryDir({}, "C:\\Users\\me")).toBe("C:\\Users\\me\\.cogpit\\memory")
    expect(memoryDatabasePath("/tmp/m")).toBe("/tmp/m/memory.db")
  })
})

describe("searchProse", () => {
  function seed(store: MemoryStore): void {
    store.syncSession(sourceFile(), makeSession([
      { user: "Why does the vitest suite segfault at teardown?", assistant: "Bun sqlite crashes when the database closes after the suite." },
      { user: "Let's talk about lunch", assistant: "Pizza works." },
    ]), { title: "Teardown crash" })
    store.syncSession(sourceFile({ path: "/t/other.jsonl", sessionId: "session-2", instanceId: "work" }), makeSession([
      { user: "The suite is slow", assistant: "Running it in parallel helps." },
    ], { cwd: "/work/other" }))
  }

  it("ranks the chunk sharing most of the rarer words first and reports how it matched", async () => {
    const store = open()
    seed(store)
    const result = await searchProse(store, "why would the suite segfault on teardown")
    expect(result.semantic.state).toBe("unavailable")
    expect(result.keywordHits).toBe(3)
    expect(result.sessionsMatched).toBe(2)
    expect(result.hits[0]).toMatchObject({
      sessionId: "session-1",
      title: "Teardown crash",
      cwd: "/work/project",
      turn: 0,
      kind: "user",
      location: "turn/0/userMessage",
      match: "keyword",
      ranks: { keyword: 1 },
      matchCount: 3,
      archived: false,
      duplicates: 0,
    })
    expect(result.hits[0].snippet).toContain("segfault")
    expect(result.hits[0].score).toBeCloseTo(1 / (RRF_K + 1))
  })

  it("stems words, so a different inflection still matches", async () => {
    const store = open()
    seed(store)
    const result = await searchProse(store, "crash")
    expect(result.hits.map((hit) => hit.location)).toEqual(["turn/0/assistantMessage"])
  })

  it("filters by session, instance, cwd, age and automation", async () => {
    const store = open()
    seed(store)
    store.syncSession(sourceFile({ path: "/t/auto.jsonl", sessionId: "session-3" }), makeSession([
      { user: "Crew chat · lead · message 1\nthe suite again", timestamp: "2020-01-01T00:00:00.000Z" },
    ]))
    const sessions = async (options: Parameters<typeof searchProse>[2]) =>
      [...new Set((await searchProse(store, "suite", options)).hits.map((hit) => hit.sessionId))].sort()
    expect(await sessions({})).toEqual(["session-1", "session-2", "session-3"])
    expect(await sessions({ sessionId: "session-2" })).toEqual(["session-2"])
    expect(await sessions({ excludeSessionId: "session-1" })).toEqual(["session-2", "session-3"])
    expect(await sessions({ instanceId: "work" })).toEqual(["session-2"])
    expect(await sessions({ cwd: "/work/other" })).toEqual(["session-2"])
    expect(await sessions({ sinceMs: Date.parse("2025-01-01") })).toEqual(["session-1", "session-2"])
    expect(await sessions({ includeAutomated: false })).toEqual(["session-1", "session-2"])
  })

  it("marks hits whose transcript is gone as archived and keeps their text", async () => {
    const store = open()
    seed(store)
    const result = await searchProse(store, "pizza", { fileExists: (path) => path !== "/transcripts/session-1.jsonl" })
    expect(result.hits).toEqual([expect.objectContaining({ archived: true, text: "Pizza works." })])
  })

  it("collapses identical text from a forked session into one hit", async () => {
    const store = open()
    const turns = [{ user: "the migration plan for the store" }]
    store.syncSession(sourceFile(), makeSession(turns))
    store.syncSession(sourceFile({ path: "/t/fork.jsonl", sessionId: "fork" }), makeSession(turns))
    const result = await searchProse(store, "migration plan")
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].duplicates).toBe(1)
    expect(result.keywordHits).toBe(2)
  })

  it("keeps only the given sessions before collapsing duplicates and cutting to the limit", async () => {
    const store = open()
    const turns = [{ user: "the migration plan for the store" }]
    store.syncSession(sourceFile({ path: "/t/hidden.jsonl", sessionId: "hidden" }), makeSession([
      { user: "migration plan, the store migration plan, and the plan for the migration" },
    ]))
    store.syncSession(sourceFile({ path: "/t/hidden-fork.jsonl", sessionId: "hidden-fork" }), makeSession(turns))
    store.syncSession(sourceFile({ path: "/t/visible.jsonl", sessionId: "visible" }), makeSession(turns))

    const visible = await searchProse(store, "migration plan", { sessionIds: ["visible"], limit: 1 })
    expect(visible.hits).toEqual([expect.objectContaining({ sessionId: "visible", duplicates: 0 })])
    expect(visible).toMatchObject({ keywordHits: 1, sessionsMatched: 1 })

    const none = await searchProse(store, "migration plan", { sessionIds: [] })
    expect(none).toMatchObject({ hits: [], keywordHits: 0, sessionsMatched: 0 })

    const many = Array.from({ length: 40_000 }, (_, i) => `other-${i}`).concat("visible")
    expect((await searchProse(store, "migration plan", { sessionIds: many })).hits.map((hit) => hit.sessionId)).toEqual(["visible"])
  })

  describe("a subagent whose transcript was deleted after its parent reported it inline", () => {
    const parent = sourceFile({ mtimeMs: 1_000 })
    const child = sourceFile({ path: "/transcripts/session-1/subagents/agent-b2.jsonl", isSubagent: true, parentSessionId: "session-1", agentId: "b2" })
    const reportText = "the deploy stalled on the migration lock"

    function seedDeletedSubagent(store: MemoryStore): void {
      store.syncSession(child, makeSession([{ assistant: reportText }]))
      const report = {
        agentId: "b2", agentName: null, subagentType: null, type: "assistant" as const, content: null, toolCalls: [], thinking: [], text: [reportText],
        timestamp: "2026-11-01T10:00:00.000Z", tokenUsage: null, model: null, isBackground: false,
      }
      const parentSession = makeSession([{ user: "go", blocks: [{ kind: "sub_agent", messages: [report] }] }])
      store.syncSession(parent, parentSession, { hasSubagentTranscript: (agentId) => agentId === "b2" })
      store.syncSession({ ...parent, mtimeMs: 2_000 }, parentSession)
    }
    const fileExists = (path: string) => path !== child.path

    it("keeps the live copy when folding duplicate text", async () => {
      const store = open()
      seedDeletedSubagent(store)
      const result = await searchProse(store, "deploy stalled migration lock", { fileExists })
      expect(result.hits).toEqual([expect.objectContaining({ sourceFile: parent.path, archived: false, duplicates: 1 })])
      expect(result.keywordHits).toBe(2)
    })

    it("drops archived text before fusion, folding and the limit with liveOnly", async () => {
      const store = open()
      seedDeletedSubagent(store)
      const checked: string[] = []
      const result = await searchProse(store, "deploy stalled migration lock", {
        liveOnly: true,
        limit: 1,
        fileExists: (path) => {
          checked.push(path)
          return fileExists(path)
        },
      })
      expect(result.hits).toEqual([expect.objectContaining({ sourceFile: parent.path, archived: false, duplicates: 0 })])
      expect(result.keywordHits).toBe(1)
      expect(checked.filter((path) => path === child.path)).toHaveLength(1)
      expect((await searchProse(store, "deploy stalled migration lock", { liveOnly: true })).keywordHits).toBe(2)
    })
  })

  it("returns nothing for a query without words and clamps the limit", async () => {
    const store = open()
    seed(store)
    expect((await searchProse(store, "...")).hits).toEqual([])
    expect((await searchProse(store, "suite", { limit: 1 })).hits).toHaveLength(1)
    expect(clampSearchLimit(0)).toBe(1)
    expect(clampSearchLimit(1000)).toBe(200)
  })
})

describe("chunkLocation", () => {
  it("names subagent transcripts, inline reports and turns in the existing style", () => {
    expect(chunkLocation({ turn: 2, kind: "assistant", agent_id: "a1", inline_agent_id: null })).toBe("agent/a1/turn/2/assistantMessage")
    expect(chunkLocation({ turn: 2, kind: "thinking", agent_id: null, inline_agent_id: "a2" })).toBe("agent/a2/thinking")
    expect(chunkLocation({ turn: 4, kind: "compaction", agent_id: null, inline_agent_id: null })).toBe("turn/4/compactionSummary")
  })
})
