// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createClaudeStore } from "../../agents/claudeStore"
import { createCodexStore } from "../../agents/codexStore"
import { createInstanceStore } from "../../agents/instanceStores"
import { instanceSessionId } from "../../../shared/session/instances"

const PARENT = "68596e24-db5d-46a4-86fe-9d82425f36d7"
const ROLLOUT = "019f85cf-0ac3-7233-84f9-ac45a79d40e9"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-list-transcripts-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, "{}\n")
}

function byPath<T extends { filePath: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.filePath < b.filePath ? -1 : 1))
}

describe("listTranscripts", () => {
  async function seedClaude(projects: string) {
    const project = join(projects, "-work-project")
    await write(join(project, `${PARENT}.jsonl`))
    await write(join(project, PARENT, "subagents", "agent-a1.jsonl"))
    await write(join(project, PARENT, "subagents", "agent-a1", "subagents", "agent-b2.jsonl"))
    await write(join(project, PARENT, "subagents", "notes.txt"))
    return project
  }

  it("lists a Claude session's own transcript and its sub-agents' files, filed under the session", async () => {
    const project = await seedClaude(join(root, "projects"))
    const files = byPath(await createClaudeStore(join(root, "projects")).listTranscripts())

    expect(files.map(({ filePath, sessionId, isSubagent, parentSessionId, agentId }) => ({ filePath, sessionId, isSubagent, parentSessionId, agentId }))).toEqual([
      { filePath: join(project, PARENT, "subagents", "agent-a1", "subagents", "agent-b2.jsonl"), sessionId: PARENT, isSubagent: true, parentSessionId: PARENT, agentId: "b2" },
      { filePath: join(project, PARENT, "subagents", "agent-a1.jsonl"), sessionId: PARENT, isSubagent: true, parentSessionId: PARENT, agentId: "a1" },
      { filePath: join(project, `${PARENT}.jsonl`), sessionId: PARENT, isSubagent: false, parentSessionId: null, agentId: null },
    ].sort((a, b) => (a.filePath < b.filePath ? -1 : 1)))
    expect(files.every((file) => file.size === 3 && file.mtimeMs > 0)).toBe(true)
  })

  it("lists every Codex rollout as a session of its own", async () => {
    const rollout = join(root, "codex", "sessions", "2026", "11", "10", `rollout-2026-11-10T10-00-00-${ROLLOUT}.jsonl`)
    await write(rollout)
    expect(await createCodexStore(join(root, "codex")).listTranscripts()).toEqual([
      expect.objectContaining({ filePath: rollout, sessionId: ROLLOUT, isSubagent: false, parentSessionId: null, agentId: null }),
    ])
  })

  it("qualifies a provider account's session ids with its instance", async () => {
    await seedClaude(join(root, "projects"))
    const store = createInstanceStore({ id: "work", agent: "claude", label: "Work", homeDir: root, createdAt: 0 })
    const files = await store.listTranscripts()
    const qualified = instanceSessionId("work", PARENT)
    expect(new Set(files.map((file) => file.sessionId))).toEqual(new Set([qualified]))
    expect(files.filter((file) => file.isSubagent).map((file) => file.parentSessionId)).toEqual([qualified, qualified])
  })
})
