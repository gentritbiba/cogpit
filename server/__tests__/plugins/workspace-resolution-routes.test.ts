// @vitest-environment node
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({ paths: [] as string[], manager: null as unknown }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => fixture.paths.map(path => ({ path, dirName: "fixture", sessionCount: 1, lastModified: null })) }] }))
vi.mock("../../plugins/manager", () => ({ getPluginManager: () => fixture.manager }))
vi.mock("../../team/edition", () => ({ isTeamEdition: () => false }))
vi.mock("../../security", () => ({ onSessionRevoked: () => () => {}, isSessionTokenActive: () => true, getSessionPrincipal: () => null }))
import { setRequestAuthentication } from "../../requestAuthentication"
import { PluginAuthorization, type PluginAuthorizationBinding } from "../../plugins/authorization"
import { PluginProjects } from "../../plugins/projects"
import { registerPluginRoutes } from "../../routes/plugins"
import type { Middleware } from "../../http"

let directory: string, workspace: string, alias: string, sessionId: string
let authorization: PluginAuthorization, projects: PluginProjects, route: Middleware, ownerRequest: IncomingMessage
async function call(body: unknown, options: { authenticated?: boolean; session?: boolean } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(req, { url: "/workspace/resolve", method: "POST", headers: { ...(options.session === false ? {} : { "x-cogpit-plugin-session": sessionId }) }, socket: { remoteAddress: "127.0.0.1" } })
  if (options.authenticated !== false) setRequestAuthentication(req, { kind: "local" })
  const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: vi.fn(), end: vi.fn() })
  await route(req, res as unknown as ServerResponse, vi.fn())
  return { status: res.statusCode, data: JSON.parse(String(res.end.mock.calls[0][0])) }
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "cogpit-workspace-route-")))
  workspace = join(directory, "workspace"); alias = join(directory, "alias")
  await mkdir(workspace); await symlink(workspace, alias, "dir")
  fixture.paths = [workspace]
  authorization = new PluginAuthorization({ hostInstanceId: "fixture-host" })
  projects = new PluginProjects()
  ownerRequest = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage
  setRequestAuthentication(ownerRequest, { kind: "local" })
  sessionId = authorization.createOrRenewSession(ownerRequest).sessionId
  ownerRequest.headers["x-cogpit-plugin-session"] = sessionId
  fixture.manager = { authorization, projects, authorize: (_req: IncomingMessage, binding: PluginAuthorizationBinding) => () => authorization.assertBinding(binding) }
  registerPluginRoutes((_path, value) => { route = value })
})
afterEach(async () => { authorization.dispose(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

describe("authenticated plugin workspace resolution", () => {
  it("resolves a symlink and its nested cwd to the host's canonical project summary", async () => {
    await mkdir(join(workspace, "nested"))
    const expected = (await projects.list())[0]
    expect(await call({ workspacePath: alias })).toEqual({ status: 200, data: expected })
    expect(await call({ workspacePath: join(alias, "nested") })).toEqual({ status: 200, data: expected })
    expect(expected.paths).toEqual([workspace])
  })

  it("returns null for unknown, relative, missing and file paths", async () => {
    const outside = join(directory, "outside"), file = join(workspace, "file")
    await mkdir(outside); await writeFile(file, "fixture")
    for (const workspacePath of [outside, "relative", join(directory, "missing"), file]) expect(await call({ workspacePath })).toEqual({ status: 200, data: null })
  })

  it("requires current authentication and a plugin session before resolving any path", async () => {
    const resolve = vi.spyOn(projects, "resolveWorkspaceProject")
    expect((await call({ workspacePath: alias }, { authenticated: false })).status).toBe(403)
    expect((await call({ workspacePath: alias }, { session: false })).status).toBe(409)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("rejects oversized or unknown fields before filesystem resolution", async () => {
    const resolve = vi.spyOn(projects, "resolveWorkspaceProject")
    expect((await call({ workspacePath: alias, projectId: "injected" })).status).toBe(400)
    expect((await call({ workspacePath: "" })).status).toBe(400)
    expect((await call({ workspacePath: "x".repeat(8193) })).status).toBe(400)
    expect((await call({ workspacePath: "x".repeat(20_000) })).status).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("does not return a project after authorization is revoked during resolution", async () => {
    const expected = (await projects.list())[0]
    vi.spyOn(projects, "resolveWorkspaceProject").mockImplementationOnce(async () => { authorization.revokeSession(ownerRequest); return expected })
    const result = await call({ workspacePath: alias })
    expect(result.status).toBe(409)
    expect(result.data).toMatchObject({ code: "STALE_ACTIVATION" })
    expect(result.data).not.toHaveProperty("paths")
  })
})
