// @vitest-environment node
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { MemoryStore } from "../../../shared/memory/store"
import { LibraryStore } from "../../library/store"
import { syncLibrary } from "../../library/sync"
import { makeSession, openMemoryStore, sourceFile } from "../memory/helpers"

const open: Array<{ close(): void }> = []
afterEach(() => { for (const store of open.splice(0)) store.close() })

function stores(): { memory: MemoryStore; library: LibraryStore } {
  const memory = openMemoryStore()
  const library = LibraryStore.open(new DatabaseSync(":memory:"))
  open.push(memory, library)
  return { memory, library }
}

function targets(library: LibraryStore): string[] {
  return library.items(null, 100).map((row) => `${row.kind}:${row.target}`)
}

describe("syncLibrary", () => {
  it("files what replies shared under their session, turn and folded project", async () => {
    const { memory, library } = stores()
    memory.syncSession(sourceFile(), makeSession([
      { user: "Take a screenshot", assistant: "Here: ![home](/tmp/home.png)", id: "t1", timestamp: "2026-11-01T10:00:00.000Z" },
      { user: "Thanks", assistant: "No assets here." },
      { user: "Open the PR", assistant: "Opened [PR](https://github.com/o/r/pull/1).", id: "t3", timestamp: "2026-11-03T10:00:00.000Z" },
    ], { cwd: "/work/app/.claude/worktrees/feature" }), { title: "Release prep" })

    expect(await syncLibrary(memory, library)).toBe(1)
    const rows = library.items({ project: "/work/app" }, 100)
    expect(rows.map((row) => [row.kind, row.target, row.turn, row.turn_id, row.shared_at])).toEqual([
      ["link", "https://github.com/o/r/pull/1", 2, "t3", "2026-11-03T10:00:00.000Z"],
      ["image", "/tmp/home.png", 0, "t1", "2026-11-01T10:00:00.000Z"],
    ])
    expect(library.sessions(["session-1"])).toEqual([{ session_id: "session-1", title: "Release prep", cwd: "/work/app/.claude/worktrees/feature" }])
  })

  it("reads a transcript again only once the memory store synced it again", async () => {
    const { memory, library } = stores()
    memory.syncSession(sourceFile(), makeSession([{ user: "a", assistant: "https://a.dev" }]), { now: 1 })
    await syncLibrary(memory, library)
    expect(await syncLibrary(memory, library)).toBe(0)

    memory.syncSession(sourceFile({ mtimeMs: 2_000, size: 200 }), makeSession([
      { user: "a", assistant: "https://a.dev" },
      { user: "b", assistant: "https://b.dev" },
    ]), { now: 2 })
    expect(await syncLibrary(memory, library)).toBe(1)
    expect(targets(library).sort()).toEqual(["link:https://a.dev", "link:https://b.dev"])
  })

  it("keeps what a rewritten transcript no longer shows", async () => {
    const { memory, library } = stores()
    memory.syncSession(sourceFile(), makeSession([{ user: "a", assistant: "https://kept.dev", id: "t1" }]), { now: 1 })
    await syncLibrary(memory, library)
    memory.syncSession(sourceFile({ mtimeMs: 2_000, size: 50 }), makeSession([{ user: "a", assistant: "Nothing now", id: "t1" }]), { now: 2 })
    await syncLibrary(memory, library)
    expect(targets(library)).toEqual(["link:https://kept.dev"])
  })

  it("leaves out sub-agents' own transcripts and their inline reports", async () => {
    const { memory, library } = stores()
    memory.syncSession(sourceFile({ path: "/t/agent.jsonl", isSubagent: true, agentId: "agent-1", parentSessionId: "session-1" }),
      makeSession([{ user: "task", assistant: "https://subagent.dev" }]))
    memory.syncSession(sourceFile(), makeSession([{
      user: "go",
      assistant: "https://parent.dev",
      blocks: [{ kind: "sub_agent", messages: [{ agentId: "agent-2", agentName: null, subagentType: null, type: "assistant", content: null, toolCalls: [], thinking: [], text: ["https://inline.dev"], timestamp: "2026-11-01T10:00:00.000Z", tokenUsage: null, model: null, isBackground: false }] }],
    }]))
    await syncLibrary(memory, library)
    expect(targets(library)).toEqual(["link:https://parent.dev"])
  })

  it("joins a long reply's stored pieces, so a code fence spanning them hides its links", async () => {
    const { memory, library } = stores()
    const code = Array.from({ length: 120 }, (_, line) => `const line${line} = "https://in-code-${line}.dev"`).join("\n")
    memory.syncSession(sourceFile(), makeSession([{ user: "show", assistant: `Code:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDocs: https://after.dev` }]))
    expect((memory.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'assistant'").get() as { n: number }).n).toBeGreaterThan(1)
    await syncLibrary(memory, library)
    expect(targets(library)).toEqual(["link:https://after.dev"])
  })

  it("stops between batches when aborted", async () => {
    const { memory, library } = stores()
    for (let index = 0; index < 30; index++) {
      memory.syncSession(sourceFile({ path: `/t/${index}.jsonl`, sessionId: `s-${index}` }), makeSession([{ user: "a", assistant: `https://${index}.dev` }], { sessionId: `s-${index}` }))
    }
    const controller = new AbortController()
    const read = await syncLibrary(memory, library, { signal: controller.signal, pause: async () => controller.abort() })
    expect(read).toBe(25)
    expect(library.sourceStates().size).toBe(25)
  })
})
