// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_KINDS, agentKindForDirName, descriptorFor } from "../../../shared/session/agent-descriptors"

const { start, recordSessionParent } = vi.hoisted(() => ({ start: vi.fn(), recordSessionParent: vi.fn() }))
vi.mock("../../agents/runtimes", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runtimeFor: () => ({ descriptor: { displayName: "Test agent" }, start }),
}))
vi.mock("../../lib/sessionLineage", () => ({ recordSessionParent }))

import { createSession } from "../../routes/session-new/sessionSpawner"

const defaultKind = agentKindForDirName(undefined)
const otherKind = AGENT_KINDS.find((kind) => kind !== defaultKind)!

beforeEach(() => {
  recordSessionParent.mockReset()
  start.mockReset().mockImplementation(async (req: { dirName: string }) => ({
    sessionId: "child-1",
    dirName: req.dirName,
    fileName: "child-1.jsonl",
    filePath: "/tmp/child-1.jsonl",
  }))
})

describe("createSession", () => {
  it("derives the project from cwd alone for the default agent", async () => {
    await createSession({ cwd: "/work/my-app", message: "hi" })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      dirName: descriptorFor(defaultKind).dirName.encode("/work/my-app"),
      cwd: "/work/my-app",
      message: "hi",
    }))
  })

  it("derives it for the agent the caller picks", async () => {
    await createSession({ cwd: "/work/my-app", agent: otherKind, message: "hi" })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      dirName: descriptorFor(otherKind).dirName.encode("/work/my-app"),
    }))
  })

  it("records the parent, and only when one is given", async () => {
    await createSession({ cwd: "/work/my-app", message: "hi", parentSessionId: "parent-1" })
    expect(recordSessionParent).toHaveBeenCalledWith("child-1", "parent-1")

    await createSession({ cwd: "/work/my-app", message: "hi" })
    expect(recordSessionParent).toHaveBeenCalledTimes(1)
  })

  it("refuses a request with neither a project nor an absolute cwd", async () => {
    await expect(createSession({ message: "hi" })).rejects.toMatchObject({ status: 400 })
    await expect(createSession({ cwd: "relative/path", message: "hi" })).rejects.toMatchObject({ status: 400 })
    expect(start).not.toHaveBeenCalled()
  })
})
