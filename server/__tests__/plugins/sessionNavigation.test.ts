// @vitest-environment node
import { parseFrameMessage } from "@cogpit/plugin-contracts"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), meta: vi.fn(), sessionId: vi.fn() }))
vi.mock("../../sessionPaths", () => ({ resolveSessionFilePath: mocks.resolve }))
vi.mock("../../sessionMetadata", () => ({ getSessionMeta: mocks.meta }))
vi.mock("../../agents", () => ({ storeForDirName: () => ({ descriptor: { sessionFile: { sessionId: mocks.sessionId } } }) }))
import { PluginSessionNavigation } from "../../plugins/sessionNavigation"
import type { PluginLease } from "../../plugins/leases"
import type { GitHubPullSession, GitHubPullSessionsResponse } from "../../../shared/contracts/github"

let root: string
let workspace: string
let transcript: string
let navigation: PluginSessionNavigation
let controller: AbortController
let lease: PluginLease
const address = { dirName: "private-directory", fileName: "nested/session.jsonl", sessionId: "session-a" }
const session: GitHubPullSession = { ...address, title: "A session", numbers: [7, 9] }
const response = (sessions = [session]): GitHubPullSessionsResponse => ({ repository: "fixture/repository", pending: 1, sessions })
const authorize = async () => {}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function presented() { return navigation.present(lease, response()).sessions[0].handle }

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-session-navigation-")))
  workspace = join(root, "workspace"); transcript = join(root, "session.jsonl")
  await mkdir(workspace); await writeFile(transcript, "fixture")
  controller = new AbortController()
  lease = { id: "lease-a", pluginId: "dev-test.probe", digest: "a".repeat(64), workspacePath: workspace, projectKey: "project-a", contextEpoch: "epoch-a", grantsRevision: 1, connectionRevision: 1, sessionId: "client-session", principalId: "owner", hostInstanceId: "host-a", expiresAt: Date.now() + 30_000, signal: controller.signal }
  navigation = new PluginSessionNavigation()
  mocks.resolve.mockReset().mockResolvedValue(transcript)
  mocks.meta.mockReset().mockResolvedValue({ cwd: workspace, sessionId: address.sessionId })
  mocks.sessionId.mockReset().mockReturnValue(null)
})
afterEach(async () => { controller.abort(); await rm(root, { recursive: true, force: true }) })

describe("lease-bound session navigation", () => {
  it("strips native addresses and returns stable opaque handles for the same lease", async () => {
    const value = navigation.present(lease, response())
    expect(value).toEqual({ repository: "fixture/repository", pending: 1, sessions: [{ handle: expect.stringMatching(/^s_[a-f0-9]{48}$/), title: "A session", numbers: [7, 9] }] })
    expect(JSON.stringify(value)).not.toContain("private-directory")
    expect(JSON.stringify(value)).not.toContain("session.jsonl")
    expect(JSON.stringify(value)).not.toContain(address.sessionId)
    expect(presented()).toBe(value.sessions[0].handle)
    expect(parseFrameMessage({ protocol: 1, type: "request", id: "navigate", method: "navigation.openSession", params: { handle: value.sessions[0].handle } })).toMatchObject({ method: "navigation.openSession" })
    await expect(navigation.resolve(lease, value.sessions[0].handle, authorize)).resolves.toEqual({ dirName: address.dirName, fileName: address.fileName })
    expect(mocks.resolve).toHaveBeenCalledWith(address.dirName, address.fileName)
  })

  it("uses the inventory's filename-derived identity for a fork with an older header ID", async () => {
    mocks.meta.mockResolvedValue({ cwd: workspace, sessionId: "parent-session" })
    mocks.sessionId.mockReturnValue(address.sessionId)
    await expect(navigation.resolve(lease, presented(), authorize)).resolves.toEqual({ dirName: address.dirName, fileName: address.fileName })
    expect(mocks.sessionId).toHaveBeenCalledWith(address.fileName)
  })

  it("rejects a changed identity when the filename codec has no identity", async () => {
    mocks.meta.mockResolvedValue({ cwd: workspace, sessionId: "another-session" })
    await expect(navigation.resolve(lease, presented(), authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
  })

  it("rejects a mismatched filename identity even when the header matches", async () => {
    mocks.sessionId.mockReturnValue("another-session")
    await expect(navigation.resolve(lease, presented(), authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
  })

  it("accepts a canonical cwd alias but rejects a different worktree in the same project", async () => {
    const alias = join(root, "workspace-alias"), other = join(root, "other-worktree")
    await symlink(workspace, alias, "dir"); await mkdir(other)
    const handle = presented()
    mocks.meta.mockResolvedValue({ cwd: alias, sessionId: address.sessionId })
    await expect(navigation.resolve(lease, handle, authorize)).resolves.toMatchObject({ fileName: address.fileName })
    mocks.meta.mockResolvedValue({ cwd: other, sessionId: address.sessionId })
    await expect(navigation.resolve(lease, handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
  })

  it("does not accept handles from another lease or after the original lease aborts", async () => {
    const handle = presented(), other = new AbortController()
    await expect(navigation.resolve({ ...lease, id: "lease-b", signal: other.signal }, handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(mocks.resolve).not.toHaveBeenCalled()
    controller.abort()
    await expect(navigation.resolve(lease, handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(() => navigation.present(lease, response())).toThrow(/session/)
    other.abort()
  })

  it("requires a bound workspace and successful storage containment resolution", async () => {
    const handle = presented()
    await expect(navigation.resolve({ ...lease, workspacePath: null }, handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(mocks.resolve).not.toHaveBeenCalled()
    mocks.resolve.mockResolvedValue(null)
    await expect(navigation.resolve(lease, handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(mocks.meta).not.toHaveBeenCalled()
  })

  it("authorizes before reading and after validating the selected transcript", async () => {
    const denied = vi.fn().mockRejectedValue(new Error("No longer authorized"))
    await expect(navigation.resolve(lease, presented(), denied)).rejects.toThrow()
    expect(mocks.resolve).not.toHaveBeenCalled()
    const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Revoked during lookup"))
    await expect(navigation.resolve(lease, presented(), guard)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(guard).toHaveBeenCalledTimes(2)
  })

  it("rejects a lease revoked while its transcript metadata is loading", async () => {
    const reached = deferred<void>(), finish = deferred<{ cwd: string; sessionId: string }>()
    mocks.meta.mockImplementationOnce(async () => { reached.resolve(); return finish.promise })
    const running = navigation.resolve(lease, presented(), authorize).then(value => ({ value }), error => ({ error }))
    await reached.promise
    controller.abort()
    finish.resolve({ cwd: workspace, sessionId: address.sessionId })
    expect(await running).toHaveProperty("error")
  })

  it("rejects a contained transcript symlink changed during metadata lookup", async () => {
    const replacement = join(root, "replacement.jsonl"), alias = join(root, "session-link.jsonl")
    await writeFile(replacement, "replacement"); await symlink(transcript, alias, "file")
    mocks.resolve.mockResolvedValue(alias)
    mocks.meta.mockImplementationOnce(async () => {
      await rm(alias); await symlink(replacement, alias, "file")
      return { cwd: workspace, sessionId: address.sessionId }
    })
    await expect(navigation.resolve(lease, presented(), authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
  })

  it("bounds each response and evicts older handles after the lease handle budget is reached", async () => {
    const many = (offset: number) => Array.from({ length: 300 }, (_, index) => ({ ...session, fileName: `session-${offset + index}.jsonl`, sessionId: `id-${offset + index}` }))
    const first = navigation.present(lease, response(many(0)))
    expect(first.sessions).toHaveLength(200)
    const second = navigation.present(lease, response(many(300)))
    expect(second.sessions).toHaveLength(200)
    await expect(navigation.resolve(lease, first.sessions[0].handle, authorize)).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
