// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getScannedSessionPullRequests, resetSessionPrIndex } from "../../lib/sessionPrIndex"
import {
  getSessionPrSearchSnapshot,
  peekSessionPullRequests,
  resetSessionPrSearchIndex,
} from "../../lib/sessionPrSearchIndex"
import { subscribeCatalog } from "../../sessionCatalog/changes"
import { dirs } from "../../sessionPaths"

let dir: string
let file: string
let previousConfigDir: string

function command(value: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: value } }],
    },
  })
}

function candidate() {
  const fileStat = statSync(file)
  return { filePath: file, size: fileStat.size, mtimeMs: fileStat.mtimeMs }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-search-index-"))
  file = join(dir, "session.jsonl")
  previousConfigDir = dirs.SESSION_CONFIG_DIR
  dirs.SESSION_CONFIG_DIR = dir
  resetSessionPrIndex()
  resetSessionPrSearchIndex()
})

afterEach(() => {
  resetSessionPrSearchIndex()
  resetSessionPrIndex()
  dirs.SESSION_CONFIG_DIR = previousConfigDir
  rmSync(dir, { recursive: true, force: true })
})

describe("getSessionPrSearchSnapshot", () => {
  it("discards a persisted index written by an older scanner and scans again", async () => {
    writeFileSync(file, `${command("gh pr view 157 --repo honest-cms/site")}\n`)
    const stale = candidate()
    writeFileSync(join(dir, "pr-search-index.json"), JSON.stringify({
      version: 1,
      entries: [[file, { size: stale.size, mtimeMs: stale.mtimeMs, pullRequests: [], references: [] }]],
    }))

    const initial = await getSessionPrSearchSnapshot([candidate()])
    expect(initial.pending).toBe(1)
    await vi.waitFor(async () => {
      const completed = await getSessionPrSearchSnapshot([candidate()])
      expect(completed.pending).toBe(0)
      expect(completed.byFile.get(file)?.references[0]?.number).toBe(157)
    })
  })

  it("indexes transcripts in the background and reloads the durable result", async () => {
    writeFileSync(file, `${command("gh pr view 157 --repo honest-cms/site")}\n`)

    const initial = await getSessionPrSearchSnapshot([candidate()])
    expect(initial.pending).toBe(1)
    expect(initial.byFile.size).toBe(0)

    await vi.waitFor(async () => {
      const completed = await getSessionPrSearchSnapshot([candidate()])
      expect(completed.pending).toBe(0)
      expect(completed.byFile.get(file)?.references).toEqual([
        { number: 157, repo: "honest-cms/site" },
      ])
    })

    // The snapshot reports `pending: 0` as soon as the scan finishes; the
    // durable write it triggers lands a tick later.
    await vi.waitFor(() => {
      const persisted = JSON.parse(readFileSync(join(dir, "pr-search-index.json"), "utf-8"))
      expect(persisted.entries).toHaveLength(1)
    })

    resetSessionPrSearchIndex()
    resetSessionPrIndex()

    const reloaded = await getSessionPrSearchSnapshot([candidate()])
    expect(reloaded.pending).toBe(0)
    expect(reloaded.byFile.get(file)?.references[0]?.number).toBe(157)
  })
})

describe("peekSessionPullRequests", () => {
  const created = (number: number) => [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${number}`, name: "Bash", input: { command: "gh pr create --fill" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${number}`, content: `https://github.com/o/r/pull/${number}` }] } }),
  ].join("\n") + "\n"

  it("answers without scanning, then has the background index scan and announce what it found", async () => {
    writeFileSync(file, created(5))
    const kinds: string[] = []
    const stop = subscribeCatalog((change) => kinds.push(change.kind))
    try {
      expect(await peekSessionPullRequests(candidate())).toBeNull()
      await vi.waitFor(async () => {
        expect((await peekSessionPullRequests(candidate()))?.pullRequests.map((pr) => pr.number)).toEqual([5])
      })
      expect(kinds).toContain("visible")
    } finally {
      stop()
    }
  })

  it("keeps the last result for a transcript written since, and drops it for one rewritten shorter", async () => {
    writeFileSync(file, created(6))
    await peekSessionPullRequests(candidate())
    await vi.waitFor(async () => expect((await peekSessionPullRequests(candidate()))?.pullRequests).toHaveLength(1))
    const scanned = candidate()

    writeFileSync(file, created(6) + created(7))
    expect((await peekSessionPullRequests({ ...candidate(), size: scanned.size + 10 }))?.pullRequests).toHaveLength(1)
    expect(await peekSessionPullRequests({ ...candidate(), size: scanned.size - 1 })).toBeNull()
  })

  it("scans the newest queued transcript first", async () => {
    const older = join(dir, "older.jsonl")
    writeFileSync(older, created(1))
    writeFileSync(file, created(2))
    const order: string[] = []
    const stop = subscribeCatalog(() => {
      for (const path of [older, file]) {
        if (!order.includes(path) && getScannedSessionPullRequests(path, statSync(path).size)?.length) order.push(path)
      }
    })
    try {
      await getSessionPrSearchSnapshot([
        { filePath: older, size: statSync(older).size, mtimeMs: 1 },
        { ...candidate(), mtimeMs: 2 },
      ])
      await vi.waitFor(() => expect(order).toHaveLength(2))
      expect(order).toEqual([file, older])
    } finally {
      stop()
    }
  })

  it("serves a result completed in an earlier run to a page that scanned nothing itself", async () => {
    writeFileSync(file, created(8))
    await peekSessionPullRequests(candidate())
    await vi.waitFor(async () => expect((await peekSessionPullRequests(candidate()))?.pullRequests).toHaveLength(1))
    resetSessionPrIndex()
    expect(getScannedSessionPullRequests(file, candidate().size)?.map((pr) => pr.number)).toEqual([8])
  })
})
