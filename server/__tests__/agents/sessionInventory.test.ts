// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { descriptorFor, type AgentKind } from "../../../shared/session/agent-descriptors"
import type { AgentStore, SessionFileInfo } from "../../agents/types"
import { inventoryFor } from "../../agents/sessionInventory"

const KINDS = ["codex", "copilot", "claude"] as const

const mocks = vi.hoisted(() => {
  const perKind = () => ({
    claude: vi.fn(),
    codex: vi.fn(),
    copilot: vi.fn(),
  }) as Record<string, ReturnType<typeof vi.fn>>
  return {
    listSessionFiles: perKind(),
    readIdentity: perKind(),
    readSessionMeta: perKind(),
    readTranscriptHead: vi.fn(),
  }
})

vi.mock("../../agents/transcriptHead", () => ({
  readTranscriptHead: mocks.readTranscriptHead,
}))

/**
 * Fake stores: the inventory only ever asks a store for its listing and its two
 * readers. Rebuilt per test, because the inventory caches per store object.
 */
let stores: Record<AgentKind, AgentStore>
function fakeStores(): Record<AgentKind, AgentStore> {
  return Object.fromEntries(KINDS.map((kind) => [kind, {
    kind,
    descriptor: descriptorFor(kind),
    listSessionFiles: mocks.listSessionFiles[kind],
    readIdentity: mocks.readIdentity[kind],
    readSessionMeta: mocks.readSessionMeta[kind],
  } as unknown as AgentStore])) as Record<AgentKind, AgentStore>
}

const getSessionInventory = (kind: AgentKind) => inventoryFor(stores[kind])

const SESSION_UUID = "68596e24-db5d-46a4-86fe-9d82425f36d7"
const HEAD = { lines: [], isPartialRead: false, size: 0 }

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

beforeEach(() => {
  stores = fakeStores()
  vi.resetAllMocks()
  mocks.readTranscriptHead.mockResolvedValue(HEAD)
  for (const kind of KINDS) {
    mocks.listSessionFiles[kind].mockResolvedValue([FILES[kind]])
    // Only the agents with a cheap head read answer here; the store owning
    // Claude's layout has no fast path and reports null by design.
    mocks.readIdentity[kind].mockResolvedValue(kind === "claude" ? null : identity)
    mocks.readSessionMeta[kind].mockResolvedValue(identity)
  }
})

describe.each(KINDS)("%s session inventory", (kind) => {
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
    mocks.readIdentity[kind].mockResolvedValueOnce(null)
    mocks.readSessionMeta[kind].mockResolvedValueOnce({
      ...identity,
      gitBranch: "feature/branch",
      model: "gpt-5",
    })

    await expect(getSessionInventory(kind)).resolves.toEqual([
      { ...file, ...identity, gitBranch: "feature/branch" },
    ])
    expect(mocks.readSessionMeta[kind]).toHaveBeenCalledWith(file.filePath, HEAD)
  })

  it("drops entries that cannot be assigned to a project", async () => {
    mocks.readIdentity[kind].mockResolvedValueOnce(null)
    mocks.readSessionMeta[kind].mockResolvedValueOnce({ sessionId: "", cwd: "", gitBranch: "" })

    await expect(getSessionInventory(kind)).resolves.toEqual([])
  })

  it("prefers the id encoded in the path over the one in the transcript header", async () => {
    mocks.readIdentity[kind].mockResolvedValueOnce(
      kind === "claude" ? null : { ...identity, sessionId: "wrong-id" },
    )
    mocks.readSessionMeta[kind].mockResolvedValue({ ...identity, sessionId: "wrong-id" })

    // A forked or resumed session keeps the id it came from in its header, so
    // the directory or file name it was written into is the authority.
    await expect(getSessionInventory(kind)).resolves.toEqual([{ ...file, ...identity }])
  })
})

describe("session inventory cache", () => {
  it("caches per store, so one agent's reload does not touch the others", async () => {
    await Promise.all([getSessionInventory("codex"), getSessionInventory("copilot")])
    stores = { ...stores, codex: fakeStores().codex }

    await Promise.all([getSessionInventory("codex"), getSessionInventory("copilot")])
    expect(mocks.listSessionFiles.codex).toHaveBeenCalledTimes(2)
    expect(mocks.listSessionFiles.copilot).toHaveBeenCalledTimes(1)
  })

  it("pays for the full metadata parse only when the head identity declines", async () => {
    await getSessionInventory("claude")
    expect(mocks.readSessionMeta.claude).toHaveBeenCalledWith(FILES.claude.filePath, HEAD)

    await getSessionInventory("codex")
    expect(mocks.readSessionMeta.codex).not.toHaveBeenCalled()
  })
})
