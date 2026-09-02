// @vitest-environment node

/**
 * The project-level answers each store gives about its own layout: which
 * projects have sessions, what one project's sessions are, how a transcript is
 * addressed, and where sub-agents live. Every route composing these is tested
 * against fakes; this is where the real filesystem shapes are pinned.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

let fixtureRoot: string
let originalCodexHome: string | undefined
let originalCopilotHome: string | undefined
let agents: typeof import("../../agents")
let sessionPaths: typeof import("../../sessionPaths")

const CLAUDE_SESSION = "68596e24-db5d-46a4-86fe-9d82425f36d7"
const CODEX_PARENT = "019f85cf-0ac3-7233-84f9-ac45a79d40e9"
const CODEX_CHILD = "9b2a3af0-9728-49a7-8f6f-f3bc66a2de22"
const COPILOT_SESSION = "e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3"

const CODEX_PARENT_NAME = `2026/07/21/rollout-2026-07-21T10-11-12-${CODEX_PARENT}.jsonl`
const CODEX_CHILD_NAME = `2026/07/21/rollout-2026-07-21T10-12-13-${CODEX_CHILD}.jsonl`

async function write(filePath: string, body: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
}

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n"

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-store-projects-"))
  originalCodexHome = process.env.CODEX_HOME
  originalCopilotHome = process.env.COPILOT_HOME
  process.env.CODEX_HOME = join(fixtureRoot, "codex-home")
  process.env.COPILOT_HOME = join(fixtureRoot, "copilot-home")
  vi.resetModules()

  agents = await import("../../agents")
  sessionPaths = await import("../../sessionPaths")
  sessionPaths.dirs.PROJECTS_DIR = join(fixtureRoot, "claude-projects")

  const claudeRoot = sessionPaths.dirs.PROJECTS_DIR
  await write(
    join(claudeRoot, "proj-x", `${CLAUDE_SESSION}.jsonl`),
    jsonl({ type: "user", sessionId: CLAUDE_SESSION, cwd: "/work/x", message: { role: "user", content: "hello" } }),
  )
  await write(join(claudeRoot, "proj-x", CLAUDE_SESSION, "subagents", "agent-abc123.jsonl"), "{}\n")

  const codexRoot = agents.storeFor("codex").sessionsRoot() as string
  await write(
    join(codexRoot, CODEX_PARENT_NAME),
    jsonl(
      { type: "session_meta", payload: { id: CODEX_PARENT, cwd: "/work/c", git: { branch: "main" } } },
      { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    ),
  )
  await write(
    join(codexRoot, CODEX_CHILD_NAME),
    jsonl({
      type: "session_meta",
      payload: {
        id: CODEX_CHILD,
        cwd: "/work/c",
        forked_from_id: CODEX_PARENT,
        source: { subagent: { thread_spawn: { parent_thread_id: CODEX_PARENT } } },
      },
    }),
  )

  const copilotRoot = agents.storeFor("copilot").sessionsRoot() as string
  await write(
    join(copilotRoot, COPILOT_SESSION, "events.jsonl"),
    jsonl(
      {
        type: "session.start",
        id: "e1",
        timestamp: "2026-07-21T10:00:00.000Z",
        data: { sessionId: COPILOT_SESSION, context: { cwd: "/work/p", branch: "main" } },
      },
      { type: "user.message", id: "e2", timestamp: "2026-07-21T10:00:01.000Z", data: { content: "hello" } },
    ),
  )
})

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = originalCopilotHome
  await rm(fixtureRoot, { recursive: true, force: true })
  vi.resetModules()
})

describe("claude store", () => {
  it("lists one project per directory, naming it after the recorded cwd", async () => {
    await expect(agents.storeFor("claude").listProjects()).resolves.toEqual([
      expect.objectContaining({ dirName: "proj-x", path: "/work/x", sessionCount: 1 }),
    ])
  })

  it("lists a project's sessions stat-only, and refuses a dirName that is not one entry", async () => {
    const store = agents.storeFor("claude")
    const files = await store.listProjectSessionFiles("proj-x")
    expect(files).toEqual([
      expect.objectContaining({ dirName: "proj-x", fileName: `${CLAUDE_SESSION}.jsonl` }),
    ])
    expect(files?.[0].sessionId).toBeUndefined()
    await expect(store.listProjectSessionFiles("../etc")).resolves.toBeNull()
  })

  it("lists top-level sessions from the path alone", async () => {
    await expect(agents.storeFor("claude").listTopLevelSessions()).resolves.toEqual([
      expect.objectContaining({ dirName: "proj-x", fileName: `${CLAUDE_SESSION}.jsonl` }),
    ])
  })

  it("finds sub-agent transcripts beside their parent and refuses an escaping address", async () => {
    const store = agents.storeFor("claude")
    await expect(store.listSubagentFiles("proj-x", CLAUDE_SESSION)).resolves.toEqual([
      expect.objectContaining({ agentId: "abc123" }),
    ])
    await expect(store.listSubagentFiles("proj-x", "no-such-session")).resolves.toEqual([])
    await expect(store.listSubagentFiles("..", "etc")).resolves.toBeNull()
  })

  it("addresses a transcript by its directory and file name", async () => {
    const filePath = join(sessionPaths.dirs.PROJECTS_DIR, "proj-x", `${CLAUDE_SESSION}.jsonl`)
    await expect(agents.storeFor("claude").sessionAddress(filePath)).resolves.toEqual({
      dirName: "proj-x",
      fileName: `${CLAUDE_SESSION}.jsonl`,
    })
    expect(agents.storeFor("claude").transcriptPath("proj-x", "new-id")).toEqual({
      fileName: "new-id.jsonl",
      filePath: join(sessionPaths.dirs.PROJECTS_DIR, "proj-x", "new-id.jsonl"),
    })
  })

  it("has no head-only identity and reads full metadata instead", async () => {
    const store = agents.storeFor("claude")
    const filePath = join(sessionPaths.dirs.PROJECTS_DIR, "proj-x", `${CLAUDE_SESSION}.jsonl`)
    await expect(store.readIdentity(filePath)).resolves.toBeNull()
    const { readTranscriptHead } = await import("../../agents/transcriptHead")
    const meta = await store.readSessionMeta(filePath, await readTranscriptHead(filePath))
    expect(meta).toMatchObject({ sessionId: CLAUDE_SESSION, cwd: "/work/x", turnCount: 1, isSubagent: false })
  })
})

describe("codex store", () => {
  const dirName = () => agents.storeFor("codex").descriptor.dirName.encode("/work/c")

  it("groups rollouts into projects by recorded cwd, excluding sub-agents", async () => {
    await expect(agents.storeFor("codex").listProjects()).resolves.toEqual([
      expect.objectContaining({ dirName: dirName(), path: "/work/c", sessionCount: 1 }),
    ])
  })

  it("lists a project's sessions with their ids, and refuses an undecodable dirName", async () => {
    const store = agents.storeFor("codex")
    await expect(store.listProjectSessionFiles(dirName())).resolves.toEqual([
      expect.objectContaining({ fileName: CODEX_PARENT_NAME, sessionId: CODEX_PARENT, dirName: dirName() }),
    ])
    await expect(store.listProjectSessionFiles("codex__%%%")).resolves.toBeNull()
  })

  it("lists top-level sessions with the dirName derived from the cwd", async () => {
    await expect(agents.storeFor("codex").listTopLevelSessions()).resolves.toEqual([
      expect.objectContaining({ dirName: dirName(), projectPath: "/work/c", sessionId: CODEX_PARENT }),
    ])
  })

  it("finds sub-agent rollouts by the parent they name", async () => {
    await expect(agents.storeFor("codex").listSubagentFiles(dirName(), CODEX_PARENT)).resolves.toEqual([
      expect.objectContaining({ agentId: CODEX_CHILD, fileName: CODEX_CHILD_NAME }),
    ])
    await expect(agents.storeFor("codex").listSubagentFiles(dirName(), CODEX_CHILD)).resolves.toEqual([])
  })

  it("resolves the UI's virtual sub-agent and bare-id paths to the flat rollout", async () => {
    const store = agents.storeFor("codex")
    const childPath = join(store.sessionsRoot() as string, CODEX_CHILD_NAME)
    await expect(store.resolveSessionFile(dirName(), `${CODEX_PARENT}/subagents/agent-${CODEX_CHILD}.jsonl`))
      .resolves.toBe(childPath)
    await expect(store.resolveSessionFile(dirName(), `${CODEX_CHILD}.jsonl`)).resolves.toBe(childPath)
    await expect(store.resolveSessionFile(dirName(), "unknown.jsonl")).resolves.toBeNull()
  })

  it("addresses a rollout by cwd and root-relative path", async () => {
    const store = agents.storeFor("codex")
    const root = store.sessionsRoot() as string
    await expect(store.sessionAddress(join(root, CODEX_PARENT_NAME))).resolves.toEqual({
      dirName: dirName(),
      fileName: CODEX_PARENT_NAME,
    })
    const target = store.transcriptPath(dirName(), "new-id")
    expect(target?.fileName).toMatch(/^\d{4}\/\d{2}\/\d{2}\/rollout-.*-new-id\.jsonl$/)
    expect(target?.filePath).toBe(join(root, target?.fileName ?? ""))
  })

  it("reads identity from the rollout header", async () => {
    const store = agents.storeFor("codex")
    await expect(store.readIdentity(join(store.sessionsRoot() as string, CODEX_CHILD_NAME))).resolves.toEqual({
      sessionId: CODEX_CHILD,
      cwd: "/work/c",
      gitBranch: "",
      isSubagent: true,
      parentSessionId: CODEX_PARENT,
    })
  })
})

describe("copilot store", () => {
  const dirName = () => agents.storeFor("copilot").descriptor.dirName.encode("/work/p")

  it("groups sessions into projects by recorded cwd", async () => {
    await expect(agents.storeFor("copilot").listProjects()).resolves.toEqual([
      expect.objectContaining({ dirName: dirName(), path: "/work/p", sessionCount: 1 }),
    ])
  })

  it("lists a project's sessions under their nested file name with the UUID as id", async () => {
    await expect(agents.storeFor("copilot").listProjectSessionFiles(dirName())).resolves.toEqual([
      expect.objectContaining({ fileName: `${COPILOT_SESSION}/events.jsonl`, sessionId: COPILOT_SESSION }),
    ])
  })

  it("has no sub-agent files: they are events inside the parent transcript", async () => {
    await expect(agents.storeFor("copilot").listSubagentFiles(dirName(), COPILOT_SESSION)).resolves.toEqual([])
  })

  it("addresses a session by cwd and its nested path", async () => {
    const store = agents.storeFor("copilot")
    const root = store.sessionsRoot() as string
    await expect(store.sessionAddress(join(root, COPILOT_SESSION, "events.jsonl"))).resolves.toEqual({
      dirName: dirName(),
      fileName: `${COPILOT_SESSION}/events.jsonl`,
    })
    expect(store.transcriptPath(dirName(), "new-id")).toEqual({
      fileName: "new-id/events.jsonl",
      filePath: join(root, "new-id", "events.jsonl"),
    })
  })

  it("reads identity from session.start", async () => {
    const store = agents.storeFor("copilot")
    await expect(store.readIdentity(join(store.sessionsRoot() as string, COPILOT_SESSION, "events.jsonl")))
      .resolves.toEqual({
        sessionId: COPILOT_SESSION,
        cwd: "/work/p",
        gitBranch: "main",
        isSubagent: false,
        parentSessionId: null,
      })
  })
})
