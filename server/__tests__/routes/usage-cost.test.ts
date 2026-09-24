// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dirs } from "../../dirs"
import type { Middleware, UseFn } from "../../helpers"

const service = vi.hoisted(() => ({
  getModelRates: vi.fn(),
  makeWindow: vi.fn(),
  readSessionUsageCostSummary: vi.fn(),
  readUsageCostSummary: vi.fn(),
}))

vi.mock("../../lib/usageCost/service", () => service)

import { registerUsageCostRoutes } from "../../routes/usage-cost"

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
const SUBAGENT = `${SESSION}/subagents/agent-a1.jsonl`

let projectsDir: string
let previousProjectsDir: string

function sessionHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/usage-cost/session") handler = candidate
  }
  registerUsageCostRoutes(use)
  if (!handler) throw new Error("Session cost route was not registered")
  return handler
}

async function request(method: string, url: string): Promise<{
  status: number
  body: unknown
  next: ReturnType<typeof vi.fn>
}> {
  let status = 200
  let body = ""
  const next = vi.fn()
  const response = {
    get statusCode() { return status },
    set statusCode(value: number) { status = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { body = value ?? "" }),
  }
  await sessionHandler()(
    { method, url } as never,
    response as never,
    next,
  )
  return { status, body: body ? JSON.parse(body) : null, next }
}

describe("session usage cost route", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    projectsDir = await mkdtemp(join(tmpdir(), "cogpit-usage-cost-route-"))
    previousProjectsDir = dirs.PROJECTS_DIR
    dirs.PROJECTS_DIR = projectsDir
    for (const fileName of [`${SESSION}.jsonl`, SUBAGENT]) {
      await mkdir(dirname(join(projectsDir, "project", fileName)), { recursive: true })
      await writeFile(join(projectsDir, "project", fileName), "{}\n")
    }
  })

  afterEach(async () => {
    dirs.PROJECTS_DIR = previousProjectsDir
    await rm(projectsDir, { recursive: true, force: true })
  })

  it("returns the selected transcript's detailed cost summary", async () => {
    const summary = { sessionId: SESSION, provider: "claude", costUsd: 1.25 }
    service.readSessionUsageCostSummary.mockResolvedValue(summary)

    const response = await request(
      "GET",
      `/?dirName=project&fileName=${SESSION}.jsonl`,
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual(summary)
    expect(service.readSessionUsageCostSummary).toHaveBeenCalledWith({
      dirName: "project",
      fileName: `${SESSION}.jsonl`,
      filePath: join(projectsDir, "project", `${SESSION}.jsonl`),
      sessionId: SESSION,
      visibleChildren: expect.any(Function),
    })
  })

  it("prices a sub-agent's transcript as no session of its own", async () => {
    service.readSessionUsageCostSummary.mockResolvedValue({})

    await request("GET", `/?dirName=project&fileName=${encodeURIComponent(SUBAGENT)}`)

    expect(service.readSessionUsageCostSummary).toHaveBeenCalledWith(expect.objectContaining({ fileName: SUBAGENT, sessionId: null }))
  })

  it("requires both transcript address fields", async () => {
    const response = await request("GET", "/?dirName=project")

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: "dirName and fileName are required" })
    expect(service.readSessionUsageCostSummary).not.toHaveBeenCalled()
  })

  it("returns 404 when the transcript cannot be resolved or read", async () => {
    service.readSessionUsageCostSummary.mockResolvedValue(null)

    for (const fileName of ["missing.jsonl", `${SESSION}.jsonl`]) {
      const response = await request("GET", `/?dirName=project&fileName=${fileName}`)
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: "Session transcript not found" })
    }
    expect(service.readSessionUsageCostSummary).toHaveBeenCalledOnce()
  })

  it("passes non-GET requests and nested paths to the next handler", async () => {
    const post = await request("POST", "/?dirName=project&fileName=session.jsonl")
    const nested = await request("GET", "/nested?dirName=project&fileName=session.jsonl")

    expect(post.next).toHaveBeenCalledOnce()
    expect(nested.next).toHaveBeenCalledOnce()
    expect(service.readSessionUsageCostSummary).not.toHaveBeenCalled()
  })
})
