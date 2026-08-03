// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readTranscriptEffort } from "../sessionMetadata"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "transcript-effort-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
  const filePath = join(tempDir, name)
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n"))
  return filePath
}

const claudeAssistant = (effort: string) => ({
  type: "assistant",
  effort,
  message: { role: "assistant", model: "claude-opus-5" },
})

const codexTurn = (effort: string) => ({
  type: "turn_context",
  payload: { turn_id: "t1", model: "gpt-5.6-sol", effort },
})

describe("readTranscriptEffort", () => {
  it("reads the effort a Claude session ran at", async () => {
    const file = await writeTranscript("claude.jsonl", [
      { type: "user", message: { role: "user", content: "hi" } },
      claudeAssistant("high"),
    ])

    expect(await readTranscriptEffort(file)).toBe("high")
  })

  it("returns the last effort, not the first, because it changes mid-session", async () => {
    const file = await writeTranscript("claude-changed.jsonl", [
      claudeAssistant("low"),
      { type: "user", message: { role: "user", content: "go deeper" } },
      claudeAssistant("xhigh"),
    ])

    expect(await readTranscriptEffort(file)).toBe("xhigh")
  })

  it("reads payload.effort from a Codex turn_context", async () => {
    const file = await writeTranscript("codex.jsonl", [
      { type: "session_meta", payload: { id: "abc", cwd: "/repo" } },
      codexTurn("ultra"),
    ])

    expect(await readTranscriptEffort(file)).toBe("ultra")
  })

  it("falls back to thread_settings.reasoning_effort on newer Codex records", async () => {
    const file = await writeTranscript("codex-thread-settings.jsonl", [
      { type: "session_meta", payload: { id: "abc", cwd: "/repo" } },
      {
        type: "turn_context",
        payload: {
          turn_id: "t1",
          thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "max" },
        },
      },
    ])

    expect(await readTranscriptEffort(file)).toBe("max")
  })

  it("ignores an empty effort string", async () => {
    const file = await writeTranscript("empty-effort.jsonl", [claudeAssistant("")])

    expect(await readTranscriptEffort(file)).toBeNull()
  })

  it("returns null when the transcript records no effort", async () => {
    const file = await writeTranscript("no-effort.jsonl", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", model: "claude-opus-5" } },
    ])

    expect(await readTranscriptEffort(file)).toBeNull()
  })

  it("returns null for a missing file rather than throwing", async () => {
    expect(await readTranscriptEffort(join(tempDir, "nope.jsonl"))).toBeNull()
  })

  it("skips malformed lines", async () => {
    const filePath = join(tempDir, "malformed.jsonl")
    await writeFile(
      filePath,
      [
        JSON.stringify(claudeAssistant("medium")),
        "{ this is not json, and it mentions effort",
      ].join("\n"),
    )

    expect(await readTranscriptEffort(filePath)).toBe("medium")
  })

  it("finds a Codex turn_context buried far behind a long final turn", async () => {
    // Regression: Codex writes turn_context once per turn, so a single long turn
    // leaves the only effort record megabytes from EOF. Real sessions were found
    // with it 593KB and 635KB back, which a capped scan missed entirely.
    const lines: unknown[] = [
      { type: "session_meta", payload: { id: "abc", cwd: "/repo" } },
      codexTurn("xhigh"),
    ]
    const noise = { type: "event_msg", payload: { type: "output", text: "z".repeat(1000) } }
    for (let i = 0; i < 800; i++) lines.push(noise)

    const file = await writeTranscript("codex-long-turn.jsonl", lines)
    expect(await readTranscriptEffort(file)).toBe("xhigh")
  })

  it("decodes correctly when multi-byte characters straddle chunk boundaries", async () => {
    // Chunks are read as bytes; splitting a multi-byte character across the seam
    // and decoding each half separately would corrupt the line and lose the hit.
    const lines: unknown[] = [claudeAssistant("medium")]
    const multiByte = { type: "user", message: { role: "user", content: "日本語🎉".repeat(400) } }
    for (let i = 0; i < 200; i++) lines.push(multiByte)

    const file = await writeTranscript("utf8-boundary.jsonl", lines)
    expect(await readTranscriptEffort(file)).toBe("medium")
  })

  it("returns the newest effort in a multi-chunk file", async () => {
    // Spans several read chunks, with an older effort record deliberately placed
    // behind the newest one so a backward scan that overshoots would be caught.
    const filler = { type: "user", isMeta: true, message: { role: "user", content: "x".repeat(200) } }
    const padded = { ...claudeAssistant("xhigh"), pad: "y".repeat(6000) }

    const lines: unknown[] = []
    for (let i = 0; i < 300; i++) lines.push(filler)
    lines.push(claudeAssistant("low"))
    for (let i = 0; i < 100; i++) lines.push(filler)
    lines.push(padded)
    for (let i = 0; i < 50; i++) lines.push(filler)

    const file = await writeTranscript("large.jsonl", lines)
    expect(await readTranscriptEffort(file)).toBe("xhigh")
  })
})
