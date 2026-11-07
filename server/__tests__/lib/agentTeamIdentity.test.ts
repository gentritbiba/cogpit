// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
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

  it("keeps a found tag while the transcript grows, and rereads one that shrinks", async () => {
    const filePath = await writeJsonl([{ type: "user", teamName: "alpha", agentName: "dev", sessionId: "s1" }])
    expect(await readSessionTeamTags(filePath)).toEqual({ teamName: "alpha", agentName: "dev" })
    // Same path, longer file: an appended transcript's head never changes, so it is not read again
    await writeFile(filePath, `${JSON.stringify({ type: "user", teamName: "beta-renamed", agentName: "dev", sessionId: "s1" })}\n`)
    expect(await readSessionTeamTags(filePath)).toEqual({ teamName: "alpha", agentName: "dev" })
    // A shorter file was rewritten, not appended to
    await writeFile(filePath, `${JSON.stringify({ teamName: "b", agentName: "d" })}\n`)
    expect(await readSessionTeamTags(filePath)).toEqual({ teamName: "b", agentName: "d" })
  })

  it("rereads a short head without tags once the transcript changes", async () => {
    const filePath = await writeJsonl([{ type: "agent-setting", sessionId: "s1" }])
    expect(await readSessionTeamTags(filePath)).toEqual({ teamName: null, agentName: null })
    await appendFile(filePath, `${JSON.stringify({ type: "user", teamName: "alpha", agentName: "dev" })}\n`)
    expect(await readSessionTeamTags(filePath)).toEqual({ teamName: "alpha", agentName: "dev" })
  })

  it("uses the stats a listing already holds", async () => {
    const filePath = await writeJsonl([{ type: "agent-setting", sessionId: "s1" }])
    const stats = await stat(filePath)
    expect(await readSessionTeamTags(filePath, stats)).toEqual({ teamName: null, agentName: null })
    await appendFile(filePath, `${JSON.stringify({ type: "user", teamName: "alpha", agentName: "dev" })}\n`)
    // Stale stats answer from the memo; current ones see the tag
    expect(await readSessionTeamTags(filePath, stats)).toEqual({ teamName: null, agentName: null })
    expect(await readSessionTeamTags(filePath, await stat(filePath))).toEqual({ teamName: "alpha", agentName: "dev" })
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

  it("prefers the member whose spawn prompt opens the transcript over one whose name it mentions", async () => {
    const members = [
      { name: "lead", agentType: "team-lead" },
      { name: "dev", prompt: "Write the parser" },
      { name: "reviewer", prompt: "Review what dev wrote in the parser" },
    ]
    const firstLine = `${JSON.stringify({ message: { content: "Review what dev wrote in the parser" } })}\n`
    await writeFile(join(root, "-work-project", LEAD, "subagents", "agent-b2.jsonl"), firstLine)
    expect(await matchSubagentToMember(LEAD, "agent-b2.jsonl", members)).toBe("reviewer")
  })

  it("reads nothing but a sub-agent file of the lead's own", async () => {
    for (const name of ["../../someone-else.jsonl", "..%2F..%2Fsomeone-else.jsonl", "someone-else.jsonl", "agent-a1.json"]) {
      expect(await matchSubagentToMember(LEAD, name, MEMBERS), name).toBeNull()
    }
  })
})
