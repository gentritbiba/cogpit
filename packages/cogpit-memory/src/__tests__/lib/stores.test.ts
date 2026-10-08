import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installDirsMock, mockDirs } from "../fixtures"

let tmpDir: string

installDirsMock()

const { listAllSessionFiles, storeFor, storeForPath } = await import("../../lib/stores")
const { findSessionFile } = await import("../../lib/stores")
const { instanceSessionId } = await import("../../lib/instances")
const originalRoot = process.env.COGPIT_ORCHESTRATION_ROOT

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
    mockDirs.ACP_PROJECTS_DIR = join(tmpDir, "acp")
    delete process.env.COGPIT_ORCHESTRATION_ROOT
    mkdirSync(mockDirs.PROJECTS_DIR, { recursive: true })
  })

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.COGPIT_ORCHESTRATION_ROOT
    else process.env.COGPIT_ORCHESTRATION_ROOT = originalRoot
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("discovers ACP and keeps identical native IDs separate across account profiles", async () => {
    process.env.COGPIT_ORCHESTRATION_ROOT = tmpDir
    const nativeId = "11111111-2222-3333-4444-555555555555"
    const paths: string[] = []
    for (const id of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) {
      const home = join(tmpDir, "provider-instances", id)
      write(join(home, "config.json"), JSON.stringify({ providerInstance: { id, agent: "acp" } }))
      paths.push(write(join(home, "projects", "-project", `${nativeId}.jsonl`)))
      const qualified = instanceSessionId(id, nativeId)
      expect(storeForPath(paths.at(-1)!)?.identify(paths.at(-1)!).sessionId).toBe(qualified)
      const path = await findSessionFile(qualified)
      expect(path).toBe(realpathSync(paths.at(-1)!))
      expect(storeForPath(path!)?.identify(path!).sessionId).toBe(qualified)
    }
    expect(new Set(listAllSessionFiles(0).map((file) => file.sessionId)).size).toBe(2)
    expect(await findSessionFile(nativeId)).toBeNull()
    expect(storeFor("acp").root()).toBe(mockDirs.ACP_PROJECTS_DIR)
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
