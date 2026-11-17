// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listSessions } from "@anthropic-ai/claude-agent-sdk"
import { createClaudeStore } from "../../agents/claudeStore"
import type { AgentStore } from "../../agents/types"

const SESSION = "44444444-4444-4444-8444-444444444444"

let configDir: string
let previousConfigDir: string | undefined
let transcript: string
const stores: AgentStore[] = []

function store(projectsRoot = join(configDir, "projects")): AgentStore {
  const created = createClaudeStore(projectsRoot)
  stores.push(created)
  return created
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "claude-archive-"))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  const project = join(configDir, "projects", "-work-app")
  mkdirSync(project, { recursive: true })
  transcript = join(project, `${SESSION}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({
    type: "user",
    uuid: "55555555-5555-4555-8555-555555555555",
    sessionId: SESSION,
    cwd: "/work/app",
    timestamp: "2026-11-17T10:00:00.000Z",
    message: { role: "user", content: "Reply with ok" },
  })}\n`)
})

afterEach(() => {
  for (const created of stores.splice(0)) created.dispose()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe("Claude Code's own session archive", () => {
  it("archives and restores through the SDK, and lists what the SDK reports", async () => {
    const claude = store()

    await claude.setArchiveMark!(transcript, true)
    const written = JSON.parse(readFileSync(join(configDir, "projects", "-work-app", SESSION, "archived.json"), "utf8"))
    expect(written).toEqual({ archived: true, at: expect.any(String), by: "sdk" })
    expect((await claude.listTopLevelSessions())[0]?.archiveMark).toEqual({ archived: true, atMs: Date.parse(written.at) })
    expect((await listSessions()).find((session) => session.sessionId === SESSION)?.archived).toBe(true)

    await claude.setArchiveMark!(transcript, false)
    expect((await claude.listTopLevelSessions())[0]?.archiveMark).toMatchObject({ archived: false })
    expect((await listSessions()).find((session) => session.sessionId === SESSION)?.archived).toBe(false)
  })

  it("refuses a store rooted outside the config directory the SDK reads", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "claude-instance-"))
    try {
      const instance = join(elsewhere, "projects", "-work-app")
      mkdirSync(instance, { recursive: true })
      writeFileSync(join(instance, `${SESSION}.jsonl`), readFileSync(transcript))

      await expect(store(join(elsewhere, "projects")).setArchiveMark!(join(instance, `${SESSION}.jsonl`), true))
        .rejects.toThrow("the SDK keeps its archive under")
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
