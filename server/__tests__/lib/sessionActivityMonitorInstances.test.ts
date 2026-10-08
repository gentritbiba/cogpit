// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import { instanceDirName, instanceSessionId } from "../../../shared/session/instances"

const mocks = vi.hoisted(() => ({ runtimeFor: vi.fn(), activity: vi.fn().mockReturnValue({ running: true }) }))
vi.mock("../../helpers", async (original) => ({
  ...await original<typeof import("../../helpers")>(),
  getSessionMeta: async () => ({ sessionId: "native-thread", cwd: "/work/repo", isSubagent: false }),
  getSessionStatus: async () => ({ status: "tool_use" }),
}))
vi.mock("../../lib/sessionOrigins", () => ({ sessionParents: async () => new Map() }))
vi.mock("../../agents/runtimes", () => ({ runtimeFor: mocks.runtimeFor }))
import { loadSnapshot } from "../../lib/sessionActivityMonitor"

describe("instance notification addresses", () => {
  it("keeps the owning instance in the project, tracker id and liveness check", async () => {
    mocks.runtimeFor.mockReturnValue({ activity: mocks.activity })
    const snapshot = await loadSnapshot({
      agentKind: "codex", instanceId: "account-1", dirName: null, fileName: "rollout.jsonl",
      filePath: "/isolated/account-1/rollout.jsonl", mtimeMs: 123,
    })
    expect(snapshot).toMatchObject({ sessionId: instanceSessionId("account-1", "rollout"), instanceId: "account-1", isActiveTurn: true })
    expect(snapshot?.dirName.startsWith(instanceDirName("account-1", "codex__"))).toBe(true)
    expect(mocks.runtimeFor).toHaveBeenCalledWith("codex", "account-1")
    expect(mocks.activity).toHaveBeenCalledWith(instanceSessionId("account-1", "native-thread"))
  })

  it.each([
    ["claude", "00000000-0000-4000-8000-000000000001.jsonl", "-work-repo"],
    ["codex", "2026/10/08/rollout-00000000-0000-4000-8000-000000000001.jsonl", null],
    ["copilot", "00000000-0000-4000-8000-000000000001/events.jsonl", null],
  ] as const)("round-trips %s notification URLs to their actual transcript", async (agentKind, fileName, nativeDir) => {
    const snapshot = await loadSnapshot({
      agentKind, instanceId: "account-1", dirName: nativeDir && instanceDirName("account-1", nativeDir), fileName,
      filePath: `/isolated/account-1/${agentKind}/${fileName}`, mtimeMs: 321,
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.sessionId).toBe(instanceSessionId("account-1", snapshot!.urlId))
    expect(descriptorForDirName(snapshot!.dirName).sessionFile.fileNameFromUrlId(snapshot!.urlId)).toBe(fileName)
  })
})
