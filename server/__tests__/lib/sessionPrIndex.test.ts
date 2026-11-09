// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCompleteSessionPullRequestData,
  resetSessionPrIndex,
} from "../../lib/sessionPrIndex"

const getSessionPullRequests = async (filePath: string, size: number) =>
  (await getCompleteSessionPullRequestData(filePath, size)).pullRequests

let dir: string
let file: string

function create(id: string, command: string, timestamp = "2026-08-14T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  })
}

function result(id: string, output: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
  })
}

function write(...lines: string[]) {
  writeFileSync(file, `${lines.join("\n")}\n`)
}

function append(...lines: string[]) {
  appendFileSync(file, `${lines.join("\n")}\n`)
}

function size(): number {
  return statSync(file).size
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-index-"))
  file = join(dir, "session.jsonl")
  resetSessionPrIndex()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("getCompleteSessionPullRequestData", () => {
  it("returns nothing for a transcript without pull requests", async () => {
    write(create("t1", "ls -la"), result("t1", "file.txt"))
    expect(await getSessionPullRequests(file, size())).toEqual([])
  })

  it("finds a pull request created in the transcript", async () => {
    write(
      create("t1", 'gh pr create --title "Add search"'),
      result("t1", "https://github.com/o/r/pull/42"),
    )
    const prs = await getSessionPullRequests(file, size())
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ number: 42, repo: "o/r", title: "Add search" })
  })

  it("indexes pull requests explicitly used by GitHub CLI", async () => {
    write(create("t1", "gh pr view 157 --repo HonestCMS/cms --json title"))

    const data = await getCompleteSessionPullRequestData(file, size())

    expect(data.pullRequests).toEqual([])
    expect(data.references).toEqual([{ number: 157, repo: "HonestCMS/cms" }])
  })

  it("indexes GitHub CLI commands nested in a Codex exec call", async () => {
    const source = 'const r = await tools.exec_command({cmd:"gh pr checks 157 --watch"}); text(r.output);'
    write(JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-01T10:00:00.000Z",
      payload: { type: "custom_tool_call", call_id: "call-1", input: source },
    }))

    const data = await getCompleteSessionPullRequestData(file, size())

    expect(data.references).toEqual([{ number: 157, repo: "" }])
  })

  it("does not index a command that only quotes gh pr text", async () => {
    write(create("t1", 'rg "gh pr view 157" src'))

    const data = await getCompleteSessionPullRequestData(file, size())

    expect(data.references).toEqual([])
  })

  it("picks up a pull request appended after the first scan", async () => {
    write(create("t1", "ls"))
    expect(await getSessionPullRequests(file, size())).toEqual([])

    append(create("t2", "gh pr create --fill"), result("t2", "https://github.com/o/r/pull/7"))
    const prs = await getSessionPullRequests(file, size())
    expect(prs.map((pr) => pr.number)).toEqual([7])
  })

  it("pairs a create with a result that arrives in a later append", async () => {
    write(create("t1", "gh pr create --fill"))
    expect(await getSessionPullRequests(file, size())).toEqual([])

    append(result("t1", "https://github.com/o/r/pull/8"))
    expect((await getSessionPullRequests(file, size())).map((pr) => pr.number)).toEqual([8])
  })

  it("does not duplicate results when called repeatedly at the same size", async () => {
    write(create("t1", "gh pr create --fill"), result("t1", "https://github.com/o/r/pull/9"))
    await getSessionPullRequests(file, size())
    const prs = await getSessionPullRequests(file, size())
    expect(prs).toHaveLength(1)
  })

  it("rescans from scratch when the file shrinks, as an undo rewrite does", async () => {
    write(create("t1", "gh pr create --fill"), result("t1", "https://github.com/o/r/pull/10"))
    expect(await getSessionPullRequests(file, size())).toHaveLength(1)

    write(create("t2", "ls"))
    expect(await getSessionPullRequests(file, size())).toEqual([])
  })

  it("returns nothing when the file is gone", async () => {
    expect(await getSessionPullRequests(join(dir, "missing.jsonl"), 100)).toEqual([])
  })

  it("keeps separate state per file", async () => {
    const other = join(dir, "other.jsonl")
    write(create("t1", "gh pr create --fill"), result("t1", "https://github.com/o/r/pull/1"))
    writeFileSync(other, `${create("t2", "gh pr create --fill")}\n${result("t2", "https://github.com/o/r/pull/2")}\n`)

    expect((await getSessionPullRequests(file, size())).map((pr) => pr.number)).toEqual([1])
    expect((await getSessionPullRequests(other, statSync(other).size)).map((pr) => pr.number)).toEqual([2])
  })

  it("scans a transcript larger than one read in a single call, yielding to the event loop between reads", async () => {
    const filler = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "x".repeat(1000) }] },
    })
    write(
      create("t1", "gh pr create --fill"),
      result("t1", "https://github.com/o/r/pull/1"),
      ...Array.from({ length: 1200 }, () => filler),
      create("t2", "gh pr create --fill"),
      result("t2", "https://github.com/o/r/pull/2"),
    )
    expect(size()).toBeGreaterThan(1024 * 1024)
    // Counts turns of the event loop; a 0 ms timer can miss a fast scan on a loaded machine.
    let ticks = 0
    let ticking = true
    const tick = () => { if (!ticking) return; ticks += 1; setImmediate(tick) }
    setImmediate(tick)
    try {
      expect((await getSessionPullRequests(file, size())).map((pr) => pr.number)).toEqual([1, 2])
    } finally {
      ticking = false
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it("handles multi-byte characters split across an append boundary", async () => {
    const title = "Añadir búsqueda — ✅"
    write(create("t1", `gh pr create --title "${title}"`))
    await getSessionPullRequests(file, size())

    append(result("t1", "https://github.com/o/r/pull/11"))
    const prs = await getSessionPullRequests(file, size())
    expect(prs[0]).toMatchObject({ number: 11, title })
  })
})
