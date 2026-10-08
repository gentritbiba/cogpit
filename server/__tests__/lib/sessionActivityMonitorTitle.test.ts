// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: null as unknown, findJsonlPath: vi.fn(), getSessionMeta: vi.fn() }))
vi.mock("../../edition", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../edition")>(),
  editionModule: () => ({ auth: mocks.auth }),
}))
vi.mock("../../sessionPaths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../sessionPaths")>(),
  findJsonlPath: mocks.findJsonlPath,
}))
vi.mock("../../helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../helpers")>(),
  getSessionMeta: mocks.getSessionMeta,
}))

import { titleFor } from "../../lib/sessionActivityMonitor"

beforeEach(() => {
  mocks.auth = null
  mocks.findJsonlPath.mockReset().mockResolvedValue("/projects/root.jsonl")
  mocks.getSessionMeta.mockReset().mockResolvedValue({ customTitle: "Wave 3 coordinator", aiTitle: "", firstUserMessage: "" })
})

describe("notification titles for crew members", () => {
  const member = { agentKind: "claude" as const, projectName: "w3-rooftop", crew: { name: "w3-rooftop", rootId: "root-1" } }

  it("names the member and its crew where everyone may see every session", async () => {
    expect(await titleFor(member)).toBe("w3-rooftop · Wave 3 coordinator")
  })

  it("names only the member where accounts may see a member without its root", async () => {
    mocks.auth = {}
    expect(await titleFor({ ...member, crew: { name: "w3-rooftop", rootId: "root-2" } })).toBe("w3-rooftop")
    expect(mocks.getSessionMeta).not.toHaveBeenCalled()
  })
})
