// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMeta } from "../sessionMetadata"

const cleanups: string[] = []

async function writeSession(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cogpit-meta-test-"))
  cleanups.push(dir)
  const filePath = join(dir, "session.jsonl")
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return filePath
}

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function userLine(text: string, timestamp = "2026-06-10T10:00:00Z") {
  return {
    type: "user",
    sessionId: "s1",
    cwd: "/tmp/proj",
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
  }
}

describe("getSessionMeta ai-title support", () => {
  it("extracts the AI-generated title from ai-title events", async () => {
    const filePath = await writeSession([
      userLine("please fix the login flow for me"),
      { type: "ai-title", aiTitle: "Fix login flow", sessionId: "s1" },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Fix login flow")
    expect(meta.firstUserMessage).toBe("please fix the login flow for me")
  })

  it("uses the most recent ai-title when the session was retitled", async () => {
    const filePath = await writeSession([
      userLine("please fix the login flow for me"),
      { type: "ai-title", aiTitle: "Fix login flow", sessionId: "s1" },
      userLine("now add tests too"),
      { type: "ai-title", aiTitle: "Fix login flow and add tests", sessionId: "s1" },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Fix login flow and add tests")
  })

  it("returns an empty aiTitle for sessions without ai-title events", async () => {
    const filePath = await writeSession([userLine("hello there friend")])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("")
  })

  it("finds an ai-title beyond the 32KB head window in large sessions (partial read)", async () => {
    // Pad past the 64KB partial-read threshold AND the 32KB head window with
    // filler assistant lines, then place the ai-title after the padding so
    // only the backward tail scan can find it.
    const filler = Array.from({ length: 40 }, (_, i) => ({
      type: "assistant",
      sessionId: "s1",
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: `filler ${i} ` + "x".repeat(2000) }],
      },
    }))
    const filePath = await writeSession([
      userLine("kick off a really long session"),
      ...filler,
      { type: "ai-title", aiTitle: "Long session title", sessionId: "s1" },
      userLine("one more message", "2026-06-10T11:00:00Z"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Long session title")
  })
})

describe("getSessionMeta agent-team tags", () => {
  it("extracts teamName and agentName from teammate session lines", async () => {
    const filePath = await writeSession([
      { type: "agent-setting", agentSetting: "claude-code-guide", sessionId: "s1" },
      {
        ...userLine("<teammate-message teammate_id=\"team-lead\">do research</teammate-message>"),
        teamName: "session-ad264e74",
        agentName: "cc-research",
      },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.teamName).toBe("session-ad264e74")
    expect(meta.agentName).toBe("cc-research")
  })

  it("returns empty team tags for regular sessions", async () => {
    const filePath = await writeSession([userLine("hello there friend")])
    const meta = await getSessionMeta(filePath)
    expect(meta.teamName).toBe("")
    expect(meta.agentName).toBe("")
  })
})
