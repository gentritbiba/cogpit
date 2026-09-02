// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { readSessionTeamTags } from "../../lib/agentTeamIdentity"

// ── readSessionTeamTags ─────────────────────────────────────────────────

describe("readSessionTeamTags", () => {
  const tagCleanups: string[] = []

  afterEach(async () => {
    const { rm } = await import("node:fs/promises")
    for (const dir of tagCleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function writeJsonl(lines: object[]): Promise<string> {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "cogpit-team-tags-"))
    tagCleanups.push(dir)
    const filePath = join(dir, "session.jsonl")
    await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return filePath
  }

  it("reads teamName and agentName from a teammate session file", async () => {
    const filePath = await writeJsonl([
      { type: "agent-setting", agentSetting: "claude-code-guide", sessionId: "s1" },
      { type: "mode", mode: "normal", sessionId: "s1" },
      {
        type: "user",
        teamName: "session-ad264e74",
        agentName: "cc-research",
        sessionId: "s1",
        message: { role: "user", content: "hello" },
      },
    ])
    const tags = await readSessionTeamTags(filePath)
    expect(tags).toEqual({ teamName: "session-ad264e74", agentName: "cc-research" })
  })

  it("returns nulls for a session without team tags", async () => {
    const filePath = await writeJsonl([
      { type: "user", sessionId: "s1", message: { role: "user", content: "hello" } },
    ])
    const tags = await readSessionTeamTags(filePath)
    expect(tags).toEqual({ teamName: null, agentName: null })
  })

  it("ignores teamName mentions inside message content", async () => {
    const filePath = await writeJsonl([
      {
        type: "user",
        sessionId: "s1",
        message: { role: "user", content: 'discussing "teamName" fields in files' },
      },
    ])
    const tags = await readSessionTeamTags(filePath)
    expect(tags).toEqual({ teamName: null, agentName: null })
  })

  it("returns nulls for a missing file", async () => {
    const tags = await readSessionTeamTags("/nonexistent/path/file.jsonl")
    expect(tags).toEqual({ teamName: null, agentName: null })
  })
})
