// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionHeader } from "../../routes/projects/index"

const cleanups: string[] = []

async function writeSessionFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cogpit-header-test-"))
  cleanups.push(dir)
  const filePath = join(dir, "session.jsonl")
  await writeFile(filePath, content)
  return filePath
}

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("readSessionHeader", () => {
  it("returns complete header lines for small files", async () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "abc" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ]
    const filePath = await writeSessionFile(lines.join("\n") + "\n")

    const header = await readSessionHeader(filePath)
    expect(header.lines).toEqual(lines)
  })

  it("captures a first line larger than the initial header read", async () => {
    // Codex 0.144+ rollouts embed the full base instructions in the first
    // session_meta line, pushing it well past 4KB.
    const metaLine = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3",
        cwd: "/tmp/project",
        base_instructions: { text: "x".repeat(20_000) },
      },
    })
    const filler = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `m${i}` } })
    )
    const filePath = await writeSessionFile([metaLine, ...filler].join("\n") + "\n")

    const header = await readSessionHeader(filePath)
    expect(header.lines[0]).toBe(metaLine)
    expect(JSON.parse(header.lines[0]).payload.id).toBe("e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3")
  })

  it("drops a truncated trailing line without dropping the complete first line", async () => {
    const metaLine = JSON.stringify({
      type: "session_meta",
      payload: { id: "abc", base_instructions: { text: "x".repeat(10_000) } },
    })
    const bigSecondLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", content: "y".repeat(200_000) },
    })
    const filePath = await writeSessionFile(metaLine + "\n" + bigSecondLine + "\n")

    const header = await readSessionHeader(filePath)
    expect(header.lines[0]).toBe(metaLine)
  })

  it("gives up gracefully on a pathological first line beyond the cap", async () => {
    const hugeLine = JSON.stringify({ type: "session_meta", payload: { text: "x".repeat(2_000_000) } })
    const filePath = await writeSessionFile(hugeLine + "\n" + '{"type":"event_msg"}' + "\n")

    const header = await readSessionHeader(filePath)
    // Cannot capture the line, but must not throw or return a truncated line
    expect(header.lines).toEqual([])
  })
})
