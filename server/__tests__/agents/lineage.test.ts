// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

let fixtureRoot: string
let originalCodexHome: string | undefined
let originalCopilotHome: string | undefined
let lineage: typeof import("../../agents/lineage")
let agents: typeof import("../../agents")
let dirs: typeof import("../../dirs").dirs
let project: string

const LEAD = "68596e24-db5d-46a4-86fe-9d82425f36d7"
const MEMBER = "019f85cf-0ac3-7233-84f9-ac45a79d40e9"
const EARLIER_MEMBER = "9b2a3af0-9728-49a7-8f6f-f3bc66a2de22"
const SOLO = "e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3"
const ORPHAN_MEMBER = "3f1d0f2a-1c4b-4a55-9f0e-7d2b6c8a1e33"
const UNDATED_MEMBER = "5c7e91b4-2a6d-4f18-8b3c-0e9a4d6f2b71"
const UNSTARTED_MEMBER = "02071699-e454-462f-938e-3ffc0d5fff53"
const REWRITING_MEMBER = "af1c6fbc-697f-431d-9920-855199be8262"
const ROGUE_MEMBER = "991eab97-436e-4f70-ac67-59158655d6cb"
const ESCAPED_MEMBER = "13bcb9ca-7159-4899-a3f9-730d004efe42"
const FORK = "0d8b8488-dae1-4982-b519-cbde0f341e3e"
const ROLLOUT = "b44cd348-43a9-4c80-9112-adfe8b7a8a4a"
const SPAWNED = "019d023f-c02d-70a3-9e7c-62d76559f6f9"
const SPAWNED_WITH_PARENT_FIELD = "019fab1c-e174-7362-b10c-74fe03162104"
const REVIEW = "019faa6b-c878-7361-8e9a-3b5182cd1ae2"
const SELF_FORK = "f35d6039-7305-4c2b-8e65-9c27b7bd99f2"
const ODD_PARENT_FORK = "d1484259-a66c-4b05-963e-5cc5f7bd88e5"
const HEADERLESS = "6973d32d-d309-434d-a359-0dd879ea2f01"
const COPILOT_SESSION = "b3c5f535-510d-40f1-9396-666ac40cf948"
const MISSING = "459159e3-208c-4116-83bf-50b7ae5184a4"

const TEAM_CREATED_AT = "2026-09-20T10:00:00.000Z"
const AFTER_CREATION = "2026-09-20T10:05:00.000Z"

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, text)
}

function write(filePath: string, lines: unknown[]): Promise<void> {
  return writeText(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
}

/** A Claude transcript opening the way a teammate's does: every line tagged with its team. */
function claudeTranscript(
  sessionId: string,
  startedAt: string,
  team?: { teamName: string; agentName: string },
): unknown[] {
  const common = { sessionId, cwd: "/work/project", version: "2.1.276", gitBranch: "main", ...team }
  return [
    {
      ...common,
      type: "user",
      uuid: `${sessionId}-u1`,
      timestamp: startedAt,
      message: { role: "user", content: "Work through the review findings" },
    },
    {
      ...common,
      type: "assistant",
      uuid: `${sessionId}-a1`,
      parentUuid: `${sessionId}-u1`,
      timestamp: startedAt,
      message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "On it." }] },
    },
  ]
}

const worker = (teamName: string) => ({ teamName, agentName: "worker" })

function writeTeammate(sessionId: string, teamName: string, startedAt = AFTER_CREATION): Promise<void> {
  return write(join(project, `${sessionId}.jsonl`), claudeTranscript(sessionId, startedAt, worker(teamName)))
}

/** A rollout whose `session_meta` header carries `payload`, as a spawned Codex thread writes it. */
function writeRollout(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  const codexHome = process.env.CODEX_HOME as string
  return write(join(codexHome, "sessions", "2026", "09", "22", `rollout-2026-09-22T11-00-00-${sessionId}.jsonl`), [{
    type: "session_meta",
    timestamp: "2026-09-22T11:00:00.000Z",
    payload: { id: sessionId, cwd: "/work/project", timestamp: "2026-09-22T11:00:00.000Z", ...payload },
  }])
}

function writeTeamConfig(configPath: string, fields: Record<string, unknown>): Promise<void> {
  const name = dirname(configPath).split("/").at(-1)
  return write(configPath, [{
    name,
    description: "Review the release",
    leadAgentId: `team-lead@${name}`,
    members: [{ agentId: `team-lead@${name}`, name: "team-lead", agentType: "team-lead" }],
    ...fields,
  }])
}

const datedLead = { createdAt: Date.parse(TEAM_CREATED_AT), leadSessionId: LEAD }

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-lineage-"))
  originalCodexHome = process.env.CODEX_HOME
  originalCopilotHome = process.env.COPILOT_HOME
  process.env.CODEX_HOME = join(fixtureRoot, "codex-home")
  process.env.COPILOT_HOME = join(fixtureRoot, "copilot-home")
  vi.resetModules()

  lineage = await import("../../agents/lineage")
  agents = await import("../../agents")
  dirs = (await import("../../dirs")).dirs
  dirs.PROJECTS_DIR = join(fixtureRoot, "claude-projects")
  dirs.TEAMS_DIR = join(fixtureRoot, "claude-teams")
  project = join(dirs.PROJECTS_DIR, "-work-project")
  const teamConfig = (teamName: string) => join(dirs.TEAMS_DIR, teamName, "config.json")

  await Promise.all([
    write(join(project, `${LEAD}.jsonl`), claudeTranscript(LEAD, "2026-09-20T09:50:00.000Z", {
      teamName: "release-review",
      agentName: "team-lead",
    })),
    writeTeammate(MEMBER, "release-review"),
    // Tagged with the same team name, but written before this team was created.
    writeTeammate(EARLIER_MEMBER, "release-review", "2026-09-01T08:00:00.000Z"),
    write(join(project, `${SOLO}.jsonl`), claudeTranscript(SOLO, AFTER_CREATION)),
    writeTeammate(ORPHAN_MEMBER, "disbanded"),
    writeTeammate(UNDATED_MEMBER, "undated"),
    writeTeammate(REWRITING_MEMBER, "rewriting"),
    writeTeammate(ROGUE_MEMBER, "rogue"),
    writeTeammate(ESCAPED_MEMBER, "../escaped"),
    // Spawned, but its first prompt has not been written yet.
    write(join(project, `${UNSTARTED_MEMBER}.jsonl`), [
      { type: "agent-name", sessionId: UNSTARTED_MEMBER, ...worker("release-review") },
    ]),
    writeTeamConfig(teamConfig("release-review"), datedLead),
    writeTeamConfig(teamConfig("undated"), { leadSessionId: LEAD }),
    writeTeamConfig(teamConfig("leaderless"), { createdAt: Date.parse(TEAM_CREATED_AT) }),
    writeTeamConfig(teamConfig("rogue"), { ...datedLead, leadSessionId: "team-lead" }),
    // Caught halfway through being rewritten.
    writeText(teamConfig("rewriting"), '{"name":"rewriting","leadSess'),
    // A readable config, but outside the teams directory.
    writeTeamConfig(join(fixtureRoot, "escaped", "config.json"), datedLead),
    writeRollout(FORK, { forked_from_id: ROLLOUT.toUpperCase() }),
    writeRollout(ROLLOUT, {}),
    writeRollout(SPAWNED, {
      source: { subagent: { thread_spawn: { parent_thread_id: ROLLOUT, depth: 1, agent_nickname: "Aristotle" } } },
    }),
    writeRollout(SPAWNED_WITH_PARENT_FIELD, {
      parent_thread_id: ROLLOUT,
      source: { subagent: { thread_spawn: { parent_thread_id: ROLLOUT, depth: 1, agent_path: "/root/prepare_pr" } } },
    }),
    writeRollout(REVIEW, { parent_thread_id: ROLLOUT, source: { subagent: "review" } }),
    writeRollout(SELF_FORK, { forked_from_id: SELF_FORK }),
    writeRollout(ODD_PARENT_FORK, { forked_from_id: "parent-session" }),
    write(
      join(process.env.CODEX_HOME, "sessions", "2026", "09", "22", `rollout-2026-09-22T12-00-00-${HEADERLESS}.jsonl`),
      [{ type: "turn_context", payload: { cwd: "/work/project" } }],
    ),
    write(join(process.env.COPILOT_HOME, "session-state", COPILOT_SESSION, "events.jsonl"), [{
      type: "session.start",
      data: { sessionId: COPILOT_SESSION, context: { cwd: "/work/project", branch: "main" } },
    }]),
  ])
})

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = originalCopilotHome
  await rm(fixtureRoot, { recursive: true, force: true })
  vi.resetModules()
})

describe("discoverParent", () => {
  it("takes the parent a fork records about itself, in lower case", async () => {
    await expect(lineage.discoverParent(FORK)).resolves.toEqual({
      parentSessionId: ROLLOUT,
      source: "transcript",
    })
  })

  it("takes the parent a spawned sub-agent or review names in any header shape", async () => {
    for (const sessionId of [SPAWNED, SPAWNED_WITH_PARENT_FIELD, REVIEW]) {
      await expect(lineage.discoverParent(sessionId)).resolves.toEqual({
        parentSessionId: ROLLOUT,
        source: "transcript",
      })
    }
  })

  it("links an agent-team member to the lead its team config names", async () => {
    await expect(lineage.discoverParent(MEMBER)).resolves.toEqual({ parentSessionId: LEAD, source: "team" })
  })

  it("settles on no parent once the transcript and any team config have been read", async () => {
    // Top-level sessions of every agent.
    await expect(lineage.discoverParent(SOLO)).resolves.toBe("none")
    await expect(lineage.discoverParent(ROLLOUT)).resolves.toBe("none")
    await expect(lineage.discoverParent(COPILOT_SESSION)).resolves.toBe("none")
    // A parent that names the session itself, or is not a session id.
    await expect(lineage.discoverParent(SELF_FORK)).resolves.toBe("none")
    await expect(lineage.discoverParent(ODD_PARENT_FORK)).resolves.toBe("none")
    // A lead that is the session itself.
    await expect(lineage.discoverParent(LEAD)).resolves.toBe("none")
  })

  it("settles on no parent when the team config refuses the member", async () => {
    // Cannot be dated against the member.
    await expect(lineage.discoverParent(UNDATED_MEMBER)).resolves.toBe("none")
    // Names a lead that is not a session id.
    await expect(lineage.discoverParent(ROGUE_MEMBER)).resolves.toBe("none")
    // Names a directory outside the teams directory.
    await expect(lineage.discoverParent(ESCAPED_MEMBER)).resolves.toBe("none")
  })

  it("says a member's team is gone when its config is, or now describes a later team", async () => {
    await expect(lineage.discoverParent(ORPHAN_MEMBER)).resolves.toBe("teamGone")
    // Created after the member started: the name was reused.
    await expect(lineage.discoverParent(EARLIER_MEMBER)).resolves.toBe("teamGone")
  })

  it("cannot tell yet when the transcript is gone or not written far enough", async () => {
    await expect(lineage.discoverParent(MISSING)).resolves.toBe("unknown")
    await expect(lineage.discoverParent(UNSTARTED_MEMBER)).resolves.toBe("unknown")
    await expect(lineage.discoverParent(HEADERLESS)).resolves.toBe("unknown")
  })

  it("cannot tell yet while the team config is being rewritten", async () => {
    await expect(lineage.discoverParent(REWRITING_MEMBER)).resolves.toBe("unknown")
  })

  it("reads a transcript at a path the caller already resolved", async () => {
    await expect(lineage.discoverParent(MEMBER, join(project, `${MEMBER}.jsonl`)))
      .resolves.toEqual({ parentSessionId: LEAD, source: "team" })
    await expect(lineage.discoverParent(MISSING, join(project, `${MISSING}.jsonl`))).resolves.toBe("unknown")
    await expect(lineage.discoverParent(SOLO, join(fixtureRoot, `${SOLO}.jsonl`))).resolves.toBe("unknown")
  })

  it("reads only a transcript's head for an agent without teams", async () => {
    const codex = agents.storeFor("codex")
    const readSessionMeta = vi.spyOn(codex, "readSessionMeta")
    try {
      await lineage.discoverParent(FORK)
      await lineage.discoverParent(ROLLOUT)
      await lineage.discoverParent(HEADERLESS)
      expect(readSessionMeta).not.toHaveBeenCalled()
    } finally {
      readSessionMeta.mockRestore()
    }
  })
})

describe("teamLeadFor", () => {
  const member = (sessionId: string, teamName: string, timestamp = AFTER_CREATION) =>
    ({ sessionId, teamName, timestamp })

  it("reads each team's config once for everyone sharing a cache", async () => {
    const configPath = join(dirs.TEAMS_DIR, "cached", "config.json")
    await writeTeamConfig(configPath, datedLead)
    const cache: import("../../agents/lineage").TeamConfigCache = new Map()

    await expect(lineage.teamLeadFor(member(MEMBER, "cached"), cache))
      .resolves.toEqual({ sessionId: LEAD, createdAt: Date.parse(TEAM_CREATED_AT) })
    await writeText(configPath, "{")
    await expect(lineage.teamLeadFor(member(UNDATED_MEMBER, "cached"), cache))
      .resolves.toEqual({ sessionId: LEAD, createdAt: Date.parse(TEAM_CREATED_AT) })
    await expect(lineage.teamLeadFor(member(UNDATED_MEMBER, "cached"))).resolves.toBe("unknown")
  })

  it("cannot tell without a start time or a teams directory", async () => {
    await expect(lineage.teamLeadFor(member(MEMBER, "release-review", ""))).resolves.toBe("unknown")
    const teamsDir = dirs.TEAMS_DIR
    dirs.TEAMS_DIR = ""
    try {
      await expect(lineage.teamLeadFor(member(MEMBER, "release-review"))).resolves.toBe("unknown")
    } finally {
      dirs.TEAMS_DIR = teamsDir
    }
  })
})

describe("teamLeadIn", () => {
  it("reads the lead session and creation time a team config names", () => {
    expect(lineage.teamLeadIn({ name: "review", ...datedLead }))
      .toEqual({ sessionId: LEAD, createdAt: Date.parse(TEAM_CREATED_AT) })
    expect(lineage.teamLeadIn({ leadSessionId: LEAD })).toEqual({ sessionId: LEAD, createdAt: null })
  })

  it("finds no lead in a config that names none", () => {
    for (const config of [null, "config", [], { createdAt: 1 }, { leadSessionId: 42 }]) {
      expect(lineage.teamLeadIn(config)).toBeNull()
    }
  })
})

describe("lineageFromMeta", () => {
  it("keeps a parent that passes the same rules discovery applies", () => {
    expect(lineage.lineageFromMeta({ sessionId: FORK.toUpperCase(), parentSessionId: ROLLOUT.toUpperCase() }, "/t/fork.jsonl"))
      .toEqual({ sessionId: FORK, parentSessionId: ROLLOUT, filePath: "/t/fork.jsonl" })
  })

  it("drops a parent that is the session itself or no session id", () => {
    expect(lineage.lineageFromMeta({ sessionId: FORK, parentSessionId: FORK.toUpperCase() }).parentSessionId).toBeNull()
    expect(lineage.lineageFromMeta({ sessionId: FORK, parentSessionId: "../escape" }).parentSessionId).toBeNull()
    expect(lineage.lineageFromMeta({ sessionId: FORK, parentSessionId: null })).toEqual({ sessionId: FORK, parentSessionId: null })
  })
})
