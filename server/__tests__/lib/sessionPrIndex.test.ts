// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionPullRequests, resetSessionPrIndex } from "../../lib/sessionPrIndex"

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

describe("getSessionPullRequests", () => {
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

  it("indexes a file larger than the per-call byte cap across successive calls", async () => {
    const filler = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "x".repeat(1000) }] },
    })
    write(
      create("t1", "gh pr create --fill"),
      result("t1", "https://github.com/o/r/pull/1"),
      ...Array.from({ length: 4600 }, () => filler),
      create("t2", "gh pr create --fill"),
      result("t2", "https://github.com/o/r/pull/2"),
    )
    expect(size()).toBeGreaterThan(4 * 1024 * 1024)

    // The first call folds in only the capped prefix …
    expect((await getSessionPullRequests(file, size())).map((pr) => pr.number)).toEqual([1])
    // … and the next resumes where it stopped rather than restarting.
    expect((await getSessionPullRequests(file, size())).map((pr) => pr.number)).toEqual([1, 2])
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
