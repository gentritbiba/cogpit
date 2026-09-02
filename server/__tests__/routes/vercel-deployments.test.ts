// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../http"
import type { LinkedVercelProject } from "../../routes/vercel-deployments"
import {
  parseBuildLogsResponse,
  parseDeploymentsResponse,
  registerVercelDeploymentRoutes,
  resolveLinkedVercelProject,
  runVercelApi,
} from "../../routes/vercel-deployments"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

const project: LinkedVercelProject = {
  root: "/repo",
  projectId: "prj_project123",
  projectName: "web",
  teamId: "team_team123",
}

const deployment = {
  uid: "dpl_2tb9j4XzU8MwpXReqzJ6aGQj4rLy",
  name: "web",
  url: "web-git-main-acme.vercel.app",
  created: 1_788_367_981_028,
  state: "READY",
  readyState: "READY",
  creator: { username: "octocat" },
  inspectorUrl: "https://vercel.com/acme/web/2tb9j4XzU8MwpXReqzJ6aGQj4rLy",
  meta: {
    githubCommitRef: "main",
    githubCommitSha: "04c62b8f88e8a20fe224d98f2fcfde830d40f5cd",
    githubCommitMessage: "Ship production",
  },
  target: "production",
  createdAt: 1_788_367_981_028,
  buildingAt: 1_788_367_982_451,
  ready: 1_788_368_169_568,
}

const logEvent = {
  created: 1_788_368_169_747,
  id: "1788368169747305138204500000",
  text: "Deployment completed",
  type: "stdout",
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function harness(apiResponse: unknown) {
  const vercelApi = vi.fn().mockResolvedValue(apiResponse)
  const resolveProject = vi.fn().mockResolvedValue(project)
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerVercelDeploymentRoutes(use, { resolveProject, vercelApi })
  return { handlers, resolveProject, vercelApi }
}

async function request(handler: Middleware, url: string) {
  let body = ""
  const response = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (value?: string) => { body = value ?? "" },
  })
  const next = vi.fn()
  await handler(asIncomingMessage({ method: "GET", url }), response, next)
  return { status: response.statusCode, data: body ? JSON.parse(body) : null, next }
}

describe("Vercel deployment routes", () => {
  it("only accepts a Vercel link at the exact active-session root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cogpit-vercel-root-"))
    temporaryRoots.push(parent)
    const child = join(parent, "app")
    await mkdir(join(parent, ".vercel"), { recursive: true })
    await mkdir(child)
    await writeFile(join(parent, ".vercel", "project.json"), JSON.stringify({
      projectId: "prj_parent",
      orgId: "team_parent",
      projectName: "parent",
    }))

    await expect(resolveLinkedVercelProject(child)).rejects.toMatchObject({
      status: 400,
      code: "vercel_project_unlinked",
    })
  })

  it("resolves a valid Vercel link from the exact root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-vercel-root-"))
    temporaryRoots.push(root)
    await mkdir(join(root, ".vercel"))
    await writeFile(join(root, ".vercel", "project.json"), JSON.stringify({
      projectId: "prj_exact",
      orgId: "team_exact",
      projectName: "exact",
    }))

    await expect(resolveLinkedVercelProject(root)).resolves.toMatchObject({
      root: await realpath(root),
      projectId: "prj_exact",
      teamId: "team_exact",
      projectName: "exact",
    })
  })

  it("normalizes deployments and build logs into the public contracts", () => {
    expect(parseDeploymentsResponse({ deployments: [deployment] })[0]).toMatchObject({
      id: deployment.uid,
      url: `https://${deployment.url}`,
      state: "READY",
      target: "production",
      branch: "main",
      commitMessage: "Ship production",
      creator: "octocat",
    })
    expect(parseBuildLogsResponse([
      logEvent,
      { ...logEvent, id: "earlier", created: logEvent.created - 1, text: "Building" },
    ])).toEqual([
      expect.objectContaining({ id: "earlier", text: "Building" }),
      expect.objectContaining({ id: logEvent.id, text: "Deployment completed" }),
    ])
  })

  it("loads deployments for the project linked at cwd", async () => {
    const { handlers, resolveProject, vercelApi } = harness({ deployments: [deployment] })
    const response = await request(
      getRouteHandler(handlers, "/api/vercel-deployments"),
      "/?cwd=%2Frepo&limit=5",
    )

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({
      projectId: project.projectId,
      projectName: "web",
      projectUrl: "https://vercel.com/acme/web",
    })
    expect(response.data.deployments).toHaveLength(1)
    expect(resolveProject).toHaveBeenCalledWith("/repo")
    expect(vercelApi).toHaveBeenCalledWith(
      project,
      "/v7/deployments?projectId=prj_project123&teamId=team_team123&limit=5",
    )
  })

  it("loads chronological build logs for a selected deployment", async () => {
    const { handlers, vercelApi } = harness([logEvent])
    const response = await request(
      getRouteHandler(handlers, "/api/vercel-deployments/build-logs"),
      `/?cwd=%2Frepo&deploymentId=${deployment.uid}&limit=100`,
    )

    expect(response.status).toBe(200)
    expect(response.data).toEqual({
      deploymentId: deployment.uid,
      events: [expect.objectContaining({ text: "Deployment completed" })],
    })
    expect(vercelApi).toHaveBeenCalledWith(
      project,
      `/v3/deployments/${deployment.uid}/events?teamId=team_team123&direction=backward&limit=100`,
    )
  })

  it("rejects malformed deployment IDs before reading the project or calling Vercel", async () => {
    const { handlers, resolveProject, vercelApi } = harness([])
    const response = await request(
      getRouteHandler(handlers, "/api/vercel-deployments/build-logs"),
      "/?cwd=%2Frepo&deploymentId=dpl_good%2Fevents",
    )

    expect(response.status).toBe(400)
    expect(resolveProject).not.toHaveBeenCalled()
    expect(vercelApi).not.toHaveBeenCalled()
  })

  it("refuses to invoke the api command when Vercel CLI is too old", async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: "48.1.6\n", stderr: "" })

    await expect(runVercelApi(project, "/v7/deployments", runCommand)).rejects.toMatchObject({
      status: 503,
      code: "vercel_cli_too_old",
    })
    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand).toHaveBeenCalledWith(project.root, ["--version"])
  })

  it("runs a current CLI with read-only api arguments", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: "Vercel CLI 59.11.2\n59.11.2\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ deployments: [] }), stderr: "" })

    await expect(runVercelApi(project, "/v7/deployments", runCommand)).resolves.toEqual({ deployments: [] })
    expect(runCommand.mock.calls[1]).toEqual([
      project.root,
      [
        "api",
        "/v7/deployments",
        "--raw",
        "--cwd",
        project.root,
        "--non-interactive",
        "--no-color",
      ],
    ])
  })
})
