// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mocks = vi.hoisted(() => ({ getSessionMeta: vi.fn(), home: "" }))
vi.mock("../../helpers", () => ({
  getSessionMeta: mocks.getSessionMeta,
  homedir: () => mocks.home,
}))

import { resolveSessionCwd } from "../../agents/sessionCwd"
import { AgentRuntimeError } from "../../agents/runtimeTypes"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-session-cwd-"))
  mocks.home = join(root, "home")
  await mkdir(mocks.home)
  await mkdir(join(root, "project"))
  mocks.getSessionMeta.mockReset().mockResolvedValue({ cwd: join(root, "project") })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("resolveSessionCwd", () => {
  it("runs a resume where the request says", async () => {
    await expect(resolveSessionCwd(mocks.home, "/sessions/a.jsonl")).resolves.toBe(mocks.home)
    expect(mocks.getSessionMeta).not.toHaveBeenCalled()
  })

  it("reads the folder back out of the transcript when the request names none", async () => {
    await expect(resolveSessionCwd(undefined, "/sessions/a.jsonl")).resolves.toBe(join(root, "project"))
  })

  it("falls back to home when nothing names a folder", async () => {
    mocks.getSessionMeta.mockResolvedValue(null)
    await expect(resolveSessionCwd(undefined, "/sessions/a.jsonl")).resolves.toBe(mocks.home)
    await expect(resolveSessionCwd(undefined, null)).resolves.toBe(mocks.home)
  })

  it("refuses a folder deleted since the session last ran, before any CLI is spawned", async () => {
    await rm(join(root, "project"), { recursive: true })

    const error = await resolveSessionCwd(undefined, "/sessions/a.jsonl").catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect(error).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: `The folder ${join(root, "project")} does not exist`,
    })
  })
})
