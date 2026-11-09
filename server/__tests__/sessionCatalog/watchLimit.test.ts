// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const watches = vi.hoisted(() => ({ opened: 0, calls: 0, limit: 2 }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      watches.calls += 1
      if (watches.opened >= watches.limit) throw Object.assign(new Error("watch limit reached"), { code: "ENOSPC" })
      watches.opened += 1
      const watcher = actual.watch(...args)
      const close = watcher.close.bind(watcher)
      watcher.close = () => { watches.opened -= 1; close() }
      return watcher
    }) as typeof actual.watch,
  }
})

const { createClaudeStore } = await import("../../agents/claudeStore")
const { resetFacts } = await import("../../sessionCatalog/facts")
const { disableSessionCatalogs, enableSessionCatalogs } = await import("../../sessionCatalog/storeCatalog")

const ID = "11111111-1111-4111-8111-111111111111"
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-catalog-limit-"))
  watches.opened = 0
  watches.calls = 0
  resetFacts()
  enableSessionCatalogs()
})

afterEach(() => {
  disableSessionCatalogs()
  resetFacts()
  rmSync(home, { recursive: true, force: true })
})

describe("session catalog when the watch limit is used up", () => {
  it("backs off instead of rescanning and rewatching in a loop, and still lists sessions", async () => {
    const root = join(home, "projects")
    for (let i = 0; i < 6; i += 1) mkdirSync(join(root, `-work-p${i}`), { recursive: true })
    writeFileSync(join(root, "-work-p0", `${ID}.jsonl`), `${JSON.stringify({ type: "user", sessionId: ID, cwd: "/work/p0", timestamp: "2026-11-09T10:00:00.000Z", message: { role: "user", content: "hi" } })}\n`)
    const store = createClaudeStore(root)
    try {
      expect((await store.listTopLevelSessions()).map((session) => session.dirName)).toEqual(["-work-p0"])
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(watches.calls).toBeLessThan(20)
      expect((await store.listTopLevelSessions()).map((session) => session.dirName)).toEqual(["-work-p0"])
    } finally {
      store.dispose()
    }
  })
})
