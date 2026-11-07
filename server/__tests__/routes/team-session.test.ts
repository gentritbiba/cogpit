// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dirs } from "../../dirs"
import type { Middleware } from "../../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerTeamSessionRoutes } from "../../routes/team-session"

const TEAM = "my-team"
const LEAD = "11111111-1111-4111-8111-111111111111"
const WORKER = "22222222-2222-4222-8222-222222222222"
const LEAD_DIR = "-work-lead"
const OTHER_DIR = "-work-other"
const CREATED_AT = Date.parse("2026-10-01T00:00:00Z")

let root: string
let saved: typeof dirs
let handlers: Map<string, Middleware>

const line = (value: object) => `${JSON.stringify(value)}\n`

async function writeTranscript(dirName: string, fileName: string, lines: object[], mtimeMs = CREATED_AT + 60_000) {
  const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, lines.map(line).join(""))
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000)
  return filePath
}

function memberLines(sessionId: string, teamName: string, agentName: string) {
  return [
    { type: "agent-setting", agentSetting: "general-purpose", sessionId },
    { type: "user", sessionId, teamName, agentName, message: { role: "user", content: `You are ${agentName}` } },
  ]
}

async function writeTeam(name: string, config: object) {
  await mkdir(join(dirs.TEAMS_DIR, name), { recursive: true })
  await writeFile(join(dirs.TEAMS_DIR, name, "config.json"), JSON.stringify(config))
}

async function get(prefix: string, url: string) {
  const { req, res, next } = createMockReqRes("GET", url)
  await getRouteHandler(handlers, prefix)(req, res, next)
  const body = res._getData()
  return { status: res._getStatus(), body: body ? JSON.parse(body) : undefined, next }
}

const memberSession = (team: string, member: string) => get("/api/team-member-session/", `${team}/${member}`)
const sessionTeam = (query: string) => get("/api/session-team", `?${query}`)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-team-session-"))
  saved = { ...dirs }
  dirs.PROJECTS_DIR = join(root, "projects")
  dirs.TEAMS_DIR = join(root, "teams")
  dirs.TASKS_DIR = join(root, "tasks")
  await mkdir(dirs.PROJECTS_DIR, { recursive: true })
  await writeTeam(TEAM, {
    name: TEAM,
    createdAt: CREATED_AT,
    leadSessionId: LEAD,
    members: [
      { name: "boss", agentType: "team-lead" },
      { name: "worker", agentType: "general-purpose", prompt: "Build the worker queue" },
    ],
  })
  await writeTranscript(LEAD_DIR, `${LEAD}.jsonl`, [{ type: "user", sessionId: LEAD, message: { role: "user", content: "lead" } }])
  handlers = collectRoutes(registerTeamSessionRoutes)
})

afterEach(async () => {
  Object.assign(dirs, saved)
  await rm(root, { recursive: true, force: true })
})

describe("GET /api/session-team", () => {
  it("passes on other methods and sub-paths, and needs a session id", async () => {
    const { req, res, next } = createMockReqRes("POST", "/")
    await getRouteHandler(handlers, "/api/session-team")(req, res, next)
    expect(next).toHaveBeenCalled()
    expect((await get("/api/session-team", "/something")).next).toHaveBeenCalled()
    expect((await sessionTeam("other=value")).status).toBe(400)
  })

  it("answers 404 when there is no teams directory", async () => {
    await rm(dirs.TEAMS_DIR, { recursive: true })
    expect((await sessionTeam(`leadSessionId=${LEAD}`)).status).toBe(404)
  })

  it("names the lead as the current member of the team it leads", async () => {
    const answer = await sessionTeam(`leadSessionId=${LEAD}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ teamName: TEAM, currentMemberName: "boss", config: { leadSessionId: LEAD } })
  })

  it("picks the most recently created team when several name the lead", async () => {
    await writeTeam("older-team", { createdAt: CREATED_AT - 1000, leadSessionId: LEAD, members: [] })
    await writeTeam("newer-team", { createdAt: CREATED_AT + 1000, leadSessionId: LEAD, members: [] })
    expect((await sessionTeam(`leadSessionId=${LEAD}`)).body.teamName).toBe("newer-team")
  })

  it("sees a config rewritten after it was first read", async () => {
    expect((await sessionTeam(`leadSessionId=${LEAD}`)).body.config.members).toHaveLength(2)
    await writeTeam(TEAM, {
      name: TEAM,
      createdAt: CREATED_AT,
      leadSessionId: LEAD,
      members: [{ name: "boss", agentType: "team-lead" }, { name: "worker" }, { name: "late-joiner" }],
    })
    expect((await sessionTeam(`leadSessionId=${LEAD}`)).body.config.members).toHaveLength(3)
  })

  it("names the member a legacy sub-agent transcript of the lead belongs to", async () => {
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-a1.jsonl`, [{ message: { content: "Build the worker queue, please" } }])
    const answer = await sessionTeam(`leadSessionId=${LEAD}&subagentFile=agent-a1.jsonl`)
    expect(answer.body.currentMemberName).toBe("worker")
  })

  it.each([`dirName=${OTHER_DIR}&`, ""])("finds the team of a teammate's own session from its tags (%s)", async (hint) => {
    await writeTranscript(OTHER_DIR, `${WORKER}.jsonl`, memberLines(WORKER, TEAM, "worker"))
    const answer = await sessionTeam(`${hint}leadSessionId=${WORKER}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ teamName: TEAM, currentMemberName: "worker" })
  })

  it("answers 404 for a session that carries no team tags", async () => {
    await writeTranscript(OTHER_DIR, `${WORKER}.jsonl`, [{ type: "user", sessionId: WORKER }])
    expect((await sessionTeam(`dirName=${OTHER_DIR}&leadSessionId=${WORKER}`)).status).toBe(404)
  })

  it("refuses a dirName hint that leaves the projects dir", async () => {
    await writeTranscript(OTHER_DIR, `${WORKER}.jsonl`, memberLines(WORKER, TEAM, "worker"))
    expect((await sessionTeam(`dirName=..&leadSessionId=${WORKER}`)).status).toBe(404)
  })
})

describe("GET /api/team-member-session/:team/:member", () => {
  it("passes on other methods and malformed paths", async () => {
    const { req, res, next } = createMockReqRes("POST", "team/member")
    await getRouteHandler(handlers, "/api/team-member-session/")(req, res, next)
    expect(next).toHaveBeenCalled()
    expect((await get("/api/team-member-session/", "team-only")).next).toHaveBeenCalled()
  })

  it("answers 404 for a team it cannot read, without the error", async () => {
    expect(await memberSession("missing", "worker")).toMatchObject({ status: 404, body: { error: "Team not found" } })
  })

  it("answers 404 for a team whose config names no lead", async () => {
    await writeTeam("leaderless", { members: [{ name: "worker" }] })
    expect((await memberSession("leaderless", "worker")).status).toBe(404)
  })

  it("addresses the lead's own transcript for the team lead", async () => {
    expect((await memberSession(TEAM, "boss")).body).toEqual({ dirName: LEAD_DIR, fileName: `${LEAD}.jsonl` })
  })

  it("answers 404 when the lead's transcript is gone", async () => {
    await rm(join(dirs.PROJECTS_DIR, LEAD_DIR), { recursive: true })
    expect((await memberSession(TEAM, "boss")).status).toBe(404)
  })

  it("finds a member's own tagged session, even outside the lead's project", async () => {
    await writeTranscript(LEAD_DIR, "33333333-3333-4333-8333-333333333333.jsonl", memberLines("33333333-3333-4333-8333-333333333333", "other-team", "worker"))
    await writeTranscript(OTHER_DIR, `${WORKER}.jsonl`, memberLines(WORKER, TEAM, "worker"))
    expect((await memberSession(TEAM, "worker")).body).toEqual({ dirName: OTHER_DIR, fileName: `${WORKER}.jsonl` })
  })

  it("passes over sessions written before the team was created", async () => {
    await writeTranscript(LEAD_DIR, `${WORKER}.jsonl`, memberLines(WORKER, TEAM, "worker"), CREATED_AT - 60_000)
    expect((await memberSession(TEAM, "worker")).status).toBe(404)
  })

  it("finds a member whose session starts after an earlier lookup missed it", async () => {
    expect((await memberSession(TEAM, "worker")).status).toBe(404)
    await writeTranscript(LEAD_DIR, `${WORKER}.jsonl`, memberLines(WORKER, TEAM, "worker"))
    expect((await memberSession(TEAM, "worker")).body).toEqual({ dirName: LEAD_DIR, fileName: `${WORKER}.jsonl` })
  })

  it("finds a member whose tags reach the transcript after the first lookup", async () => {
    const filePath = await writeTranscript(LEAD_DIR, `${WORKER}.jsonl`, [{ type: "agent-setting", sessionId: WORKER }])
    expect((await memberSession(TEAM, "worker")).status).toBe(404)
    await writeFile(filePath, memberLines(WORKER, TEAM, "worker").map(line).join(""))
    expect((await memberSession(TEAM, "worker")).body).toEqual({ dirName: LEAD_DIR, fileName: `${WORKER}.jsonl` })
  })

  it("finds a legacy member's sub-agent transcript under the lead by its spawn prompt", async () => {
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-zz.jsonl`, [{ message: { content: "Someone else entirely" } }])
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-a1.jsonl`, [{ message: { content: "Build the worker queue" } }])
    expect((await memberSession(TEAM, "worker")).body).toEqual({ dirName: LEAD_DIR, fileName: `${LEAD}/subagents/agent-a1.jsonl` })
  })

  it("tells apart legacy members whose names contain one another", async () => {
    await writeTeam("legacy", {
      createdAt: CREATED_AT + 1,
      leadSessionId: LEAD,
      members: [{ name: "boss", agentType: "team-lead" }, { name: "dev-1" }, { name: "dev-10" }],
    })
    // dev-10's files come before dev-1's in name, creation and reverse-creation order
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-0ten.jsonl`, [{ message: { content: "You are dev-10" } }])
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-one.jsonl`, [{ message: { content: "You are dev-1" } }])
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-zten.jsonl`, [{ message: { content: "You are dev-10" } }])
    expect((await memberSession("legacy", "dev-1")).body.fileName).toBe(`${LEAD}/subagents/agent-one.jsonl`)
    expect((await memberSession("legacy", "dev-10")).body.fileName).toMatch(/agent-(0|z)ten\.jsonl$/)
    expect((await sessionTeam(`leadSessionId=${LEAD}&subagentFile=agent-0ten.jsonl`)).body.currentMemberName).toBe("dev-10")
  })

  it("answers 404 when no session belongs to the member", async () => {
    await writeTranscript(LEAD_DIR, `${LEAD}/subagents/agent-a1.jsonl`, [{ message: { content: "unrelated" } }])
    expect(await memberSession(TEAM, "worker")).toMatchObject({ status: 404, body: { error: "Member session not found" } })
  })
})
