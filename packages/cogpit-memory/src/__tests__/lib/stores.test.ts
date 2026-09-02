import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let tmpDir: string
const mockDirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  CODEX_SESSIONS_DIR: "",
  COPILOT_SESSIONS_DIR: "",
}

mock.module("../../lib/dirs", () => ({ dirs: mockDirs, DEFAULT_DB_PATH: "" }))

const { listAllSessionFiles, storeFor, storeForPath } = await import("../../lib/stores")

function write(filePath: string, content = "{}\n"): string {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content)
  return filePath
}

describe("agent session stores", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-stores-"))
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot")
    mkdirSync(mockDirs.PROJECTS_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("lists every agent's transcripts from one walk", () => {
    write(join(mockDirs.PROJECTS_DIR, "-proj", "session-a.jsonl"))
    write(join(mockDirs.CODEX_SESSIONS_DIR, "2026", "01", "01", "rollout-x.jsonl"))
    write(join(mockDirs.COPILOT_SESSIONS_DIR, "session-c", "events.jsonl"))

    const kinds = listAllSessionFiles(0)
      .map((file) => storeForPath(file.path)?.kind)
      .sort()

    expect(kinds).toEqual(["claude", "codex", "copilot"])
  })

  it("takes a Copilot session id from its directory, never from `events`", () => {
    const filePath = write(join(mockDirs.COPILOT_SESSIONS_DIR, "session-c", "events.jsonl"))

    expect(storeFor("copilot").identify(filePath).sessionId).toBe("session-c")
    expect(listAllSessionFiles(0)[0].sessionId).toBe("session-c")
  })

  it("recovers a sub-agent's parent without splitting the path on a literal slash", () => {
    const parentId = "11111111-2222-3333-4444-555555555555"
    const projectDir = join(mockDirs.PROJECTS_DIR, "-proj")
    write(join(projectDir, `${parentId}.jsonl`))
    const agentPath = write(join(projectDir, parentId, "subagents", "agent-7.jsonl"))

    // Built from path segments rather than `filePath.split("/")`, which found
    // nothing at all on Windows.
    expect(storeFor("claude").identify(agentPath)).toEqual({
      sessionId: parentId,
      isSubagent: true,
      parentSessionId: parentId,
    })
  })

  it("does not report a root as owned by itself", () => {
    expect(storeForPath(mockDirs.PROJECTS_DIR)).toBeNull()
    expect(storeForPath(join(mockDirs.PROJECTS_DIR, "-proj", "s.jsonl"))?.kind).toBe("claude")
  })
})
