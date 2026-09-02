// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { descriptorFor, type AgentKind } from "../../../shared/session/agent-descriptors"
import type { AgentStore, SessionFileInfo } from "../../agents/types"

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn(),
  getCodexSessionIdentity: vi.fn(),
  getCopilotSessionIdentity: vi.fn(),
  listSessionFiles: {
    claude: vi.fn(),
    codex: vi.fn(),
    copilot: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock("../../sessionMetadata", () => ({
  getSessionMeta: mocks.getSessionMeta,
  getCodexSessionIdentity: mocks.getCodexSessionIdentity,
  getCopilotSessionIdentity: mocks.getCopilotSessionIdentity,
}))

vi.mock("../../agents", () => {
  const stores = (["codex", "copilot", "claude"] as const).map((kind) => ({
    kind,
    descriptor: descriptorFor(kind),
    listSessionFiles: mocks.listSessionFiles[kind],
  })) as unknown as AgentStore[]
  return { allStores: () => stores }
})

import { getSessionInventory, invalidateSessionInventory } from "../../lib/sessionInventory"

const SESSION_UUID = "68596e24-db5d-46a4-86fe-9d82425f36d7"

/** One listed transcript per agent, in that agent's own naming. */
const FILES: Record<AgentKind, SessionFileInfo> = {
  claude: {
    filePath: `/projects/proj/${SESSION_UUID}.jsonl`,
    fileName: `${SESSION_UUID}.jsonl`,
    dirName: "proj",
    mtimeMs: 1000,
    size: 500,
  },
  codex: {
    filePath: `/sessions/2026/07/21/rollout-2026-07-21T10-11-12-${SESSION_UUID}.jsonl`,
    fileName: `2026/07/21/rollout-2026-07-21T10-11-12-${SESSION_UUID}.jsonl`,
    dirName: null,
    mtimeMs: 1000,
    size: 500,
  },
  copilot: {
    filePath: `/session-state/${SESSION_UUID}/events.jsonl`,
    fileName: `${SESSION_UUID}/events.jsonl`,
    dirName: null,
    mtimeMs: 1000,
    size: 500,
  },
}

const identity = {
  sessionId: SESSION_UUID,
  cwd: "/code/project",
  gitBranch: "main",
  isSubagent: false,
  parentSessionId: null,
}

/** Which fast-identity reader each agent has, if any. */
const FAST_IDENTITY: Partial<Record<AgentKind, ReturnType<typeof vi.fn>>> = {
  codex: mocks.getCodexSessionIdentity,
  copilot: mocks.getCopilotSessionIdentity,
}

beforeEach(() => {
  invalidateSessionInventory()
  vi.resetAllMocks()
  for (const kind of ["claude", "codex", "copilot"] as const) {
    mocks.listSessionFiles[kind].mockResolvedValue([FILES[kind]])
  }
  mocks.getCodexSessionIdentity.mockResolvedValue(identity)
  mocks.getCopilotSessionIdentity.mockResolvedValue(identity)
  mocks.getSessionMeta.mockResolvedValue(identity)
})

describe.each(["claude", "codex", "copilot"] as const)("%s session inventory", (kind) => {
  const file = FILES[kind]

  it("shares one cold load across concurrent callers", async () => {
    const [first, second] = await Promise.all([
      getSessionInventory(kind),
      getSessionInventory(kind),
    ])

    expect(first).toEqual([{ ...file, ...identity }])
    expect(second).toBe(first)
    expect(mocks.listSessionFiles[kind]).toHaveBeenCalledTimes(1)
  })

  it("reuses the recent inventory without touching the filesystem", async () => {
    await getSessionInventory(kind)
    await getSessionInventory(kind)

    expect(mocks.listSessionFiles[kind]).toHaveBeenCalledTimes(1)
  })

  it("falls back to the full metadata parse when the head read yields nothing", async () => {
    FAST_IDENTITY[kind]?.mockResolvedValueOnce(null)
    mocks.getSessionMeta.mockResolvedValueOnce({
      ...identity,
      gitBranch: "feature/branch",
      model: "gpt-5",
    })

    await expect(getSessionInventory(kind)).resolves.toEqual([
      { ...file, ...identity, gitBranch: "feature/branch" },
    ])
    expect(mocks.getSessionMeta).toHaveBeenCalledWith(file.filePath)
  })

  it("drops entries that cannot be assigned to a project", async () => {
    FAST_IDENTITY[kind]?.mockResolvedValueOnce(null)
    mocks.getSessionMeta.mockResolvedValueOnce({ sessionId: "", cwd: "", gitBranch: "" })

    await expect(getSessionInventory(kind)).resolves.toEqual([])
  })

  it("prefers the id encoded in the path over the one in the transcript header", async () => {
    FAST_IDENTITY[kind]?.mockResolvedValueOnce({ ...identity, sessionId: "wrong-id" })
    mocks.getSessionMeta.mockResolvedValue({ ...identity, sessionId: "wrong-id" })

    // A forked or resumed session keeps the id it came from in its header, so
    // the directory or file name it was written into is the authority.
    await expect(getSessionInventory(kind)).resolves.toEqual([{ ...file, ...identity }])
  })
})

describe("session inventory cache", () => {
  it("invalidates one agent without dropping the others", async () => {
    await Promise.all([getSessionInventory("codex"), getSessionInventory("copilot")])
    invalidateSessionInventory("codex")

    await Promise.all([getSessionInventory("codex"), getSessionInventory("copilot")])
    expect(mocks.listSessionFiles.codex).toHaveBeenCalledTimes(2)
    expect(mocks.listSessionFiles.copilot).toHaveBeenCalledTimes(1)
  })

  it("only reads a head identity for agents that have one", async () => {
    await getSessionInventory("claude")
    expect(mocks.getCodexSessionIdentity).not.toHaveBeenCalled()
    expect(mocks.getCopilotSessionIdentity).not.toHaveBeenCalled()
    expect(mocks.getSessionMeta).toHaveBeenCalledWith(FILES.claude.filePath)
  })
})
