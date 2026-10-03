// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirs } from "../../dirs"
import { matchSubagentToMember, readSessionTeamTags } from "../../lib/agentTeamIdentity"

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

// ── matchSubagentToMember ───────────────────────────────────────────────

describe("matchSubagentToMember", () => {
  const LEAD = "lead-session"
  const MEMBERS = [
    { name: "lead", agentType: "team-lead" },
    { name: "reviewer", agentType: "general-purpose", prompt: "Review the release notes" },
  ]
  let root: string
  let previousProjectsDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cogpit-team-member-"))
    previousProjectsDir = dirs.PROJECTS_DIR
    dirs.PROJECTS_DIR = root
    const subagents = join(root, "-work-project", LEAD, "subagents")
    await mkdir(subagents, { recursive: true })
    const firstLine = `${JSON.stringify({ message: { content: "You are reviewer. Review the release notes" } })}\n`
    await writeFile(join(subagents, "agent-a1.jsonl"), firstLine)
    await writeFile(join(root, "-work-project", "someone-else.jsonl"), firstLine)
  })

  afterEach(async () => {
    dirs.PROJECTS_DIR = previousProjectsDir
    await rm(root, { recursive: true, force: true })
  })

  it("names the member whose name or prompt opens the sub-agent's transcript", async () => {
    expect(await matchSubagentToMember(LEAD, "agent-a1.jsonl", MEMBERS)).toBe("reviewer")
  })

  it("reads nothing but a sub-agent file of the lead's own", async () => {
    for (const name of ["../../someone-else.jsonl", "..%2F..%2Fsomeone-else.jsonl", "someone-else.jsonl", "agent-a1.json"]) {
      expect(await matchSubagentToMember(LEAD, name, MEMBERS), name).toBeNull()
    }
  })
})
