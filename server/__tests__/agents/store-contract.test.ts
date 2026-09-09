// @vitest-environment node

/**
 * One suite, run against all three stores.
 *
 * Every store answers the same six questions about completely different on-disk
 * layouts, so the assertions that matter — a listed file resolves back to
 * itself, nothing escapes the root, a symlink out is refused — are written once
 * and parameterised. Anything genuinely per-agent (Codex's dated nesting,
 * Copilot's exact `<uuid>/events.jsonl` shape) gets its own block at the end.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import type { AgentStore } from "../../agents/types"

let fixtureRoot: string
let originalCodexHome: string | undefined
let originalCopilotHome: string | undefined
let agents: typeof import("../../agents")
let sessionPaths: typeof import("../../sessionPaths")

/** A session each store can be asked to produce, written into its own layout. */
interface Seeded {
  sessionId: string
  dirName: string
  fileName: string
  filePath: string
}

interface StoreCase {
  kind: AgentKind
  store: () => AgentStore
  /** Write one session into this agent's storage and describe how to address it. */
  seed: (label: string) => Promise<Seeded>
}

const UUIDS = [
  "68596e24-db5d-46a4-86fe-9d82425f36d7",
  "019f85cf-0ac3-7233-84f9-ac45a79d40e9",
  "9b2a3af0-9728-49a7-8f6f-f3bc66a2de22",
  "e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3",
  "3f1d0f2a-1c4b-4a55-9f0e-7d2b6c8a1e33",
  "5c7e91b4-2a6d-4f18-8b3c-0e9a4d6f2b71",
]
let nextUuid = 0
const takeUuid = (): string => UUIDS[nextUuid++ % UUIDS.length]

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-agent-store-"))
  originalCodexHome = process.env.CODEX_HOME
  originalCopilotHome = process.env.COPILOT_HOME
  process.env.CODEX_HOME = join(fixtureRoot, "codex-home")
  process.env.COPILOT_HOME = join(fixtureRoot, "copilot-home")
  vi.resetModules()

  agents = await import("../../agents")
  sessionPaths = await import("../../sessionPaths")

  sessionPaths.dirs.PROJECTS_DIR = join(fixtureRoot, "claude-projects")
  await Promise.all(
    agents.allStores().map((store) => mkdir(store.sessionsRoot() as string, { recursive: true })),
  )
})

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME
  else process.env.COPILOT_HOME = originalCopilotHome
  await rm(fixtureRoot, { recursive: true, force: true })
  vi.resetModules()
})

async function write(filePath: string, body = '{"type":"session_meta"}\n'): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
}

const CASES: StoreCase[] = [
  {
    kind: "claude",
    store: () => agents.storeFor("claude"),
    async seed(label) {
      const sessionId = takeUuid()
      const dirName = `project-${label}`
      const fileName = `${sessionId}.jsonl`
      const filePath = join(sessionPaths.dirs.PROJECTS_DIR, dirName, fileName)
      await write(filePath)
      return { sessionId, dirName, fileName, filePath }
    },
  },
  {
    kind: "codex",
    store: () => agents.storeFor("codex"),
    async seed(label) {
      const sessionId = takeUuid()
      const fileName = `2026/07/21/rollout-2026-07-21T10-11-12-${sessionId}.jsonl`
      const root = agents.storeFor("codex").sessionsRoot() as string
      const filePath = join(root, fileName)
      await write(filePath)
      return {
        sessionId,
        dirName: agents.storeFor("codex").descriptor.dirName.encode(`/work/${label}`),
        fileName,
        filePath,
      }
    },
  },
  {
    kind: "copilot",
    store: () => agents.storeFor("copilot"),
    async seed(label) {
      const sessionId = takeUuid()
      const fileName = `${sessionId}/events.jsonl`
      const root = agents.storeFor("copilot").sessionsRoot() as string
      const filePath = join(root, fileName)
      await write(filePath, '{"type":"session.start"}\n')
      return {
        sessionId,
        dirName: agents.storeFor("copilot").descriptor.dirName.encode(`/work/${label}`),
        fileName,
        filePath,
      }
    },
  },
]

describe.each(CASES)("$kind store", ({ kind, store, seed }) => {
  it("reports a configured sessions root it owns paths under", async () => {
    const root = store().sessionsRoot()
    expect(root).toBeTruthy()
    const seeded = await seed("owns")
    expect(store().ownsPath(seeded.filePath)).toBe(true)
    // The root itself is not a session, and a sibling directory is not inside it.
    expect(store().ownsPath(root as string)).toBe(false)
    expect(store().ownsPath(`${root}-archive${sep}other.jsonl`)).toBe(false)
  })

  it("lists a seeded session and resolves its addressed name back to the same file", async () => {
    const seeded = await seed("listing")
    const listed = (await store().listSessionFiles())
      .find((file) => file.filePath === seeded.filePath)

    expect(listed).toMatchObject({ filePath: seeded.filePath, fileName: seeded.fileName })
    expect(listed?.size).toBeGreaterThan(0)
    await expect(store().resolveSessionFile(seeded.dirName, seeded.fileName))
      .resolves.toBe(seeded.filePath)
  })

  it("carries a dirName only when the layout encodes one", async () => {
    const seeded = await seed("dirname")
    const listed = (await store().listSessionFiles())
      .find((file) => file.filePath === seeded.filePath)

    // Claude names a directory per project; the others record the project
    // inside the transcript, so listing cannot know it.
    expect(listed?.dirName).toBe(kind === "claude" ? seeded.dirName : null)
  })

  it("finds a seeded session by id", async () => {
    const seeded = await seed("find")
    await expect(store().findSessionFile(seeded.sessionId)).resolves.toBe(seeded.filePath)
    await expect(store().findSessionFile("00000000-0000-4000-8000-000000000000"))
      .resolves.toBeNull()
  })

  it("refuses to resolve outside its own storage root", async () => {
    const seeded = await seed("traversal")
    for (const fileName of ["../../outside.jsonl", "../outside/events.jsonl"]) {
      await expect(store().resolveSessionFile(seeded.dirName, fileName)).resolves.toBeNull()
    }
  })

  it("refuses a transcript symlinked out of the root, and drops it from the listing", async () => {
    const seeded = await seed("symlink")
    const outside = join(fixtureRoot, `outside-${kind}.jsonl`)
    await writeFile(outside, "{}\n")
    await rm(seeded.filePath)
    await symlink(outside, seeded.filePath)

    await expect(store().resolveSessionFile(seeded.dirName, seeded.fileName)).resolves.toBeNull()
    const listed = await store().listSessionFiles()
    expect(listed.some((file) => file.filePath === seeded.filePath)).toBe(false)
  })

  it("is the store the registry picks for its own paths and dirNames", async () => {
    const seeded = await seed("registry")
    expect(agents.storeForPath(seeded.filePath)?.kind).toBe(kind)
    expect(agents.storeForDirName(seeded.dirName).kind).toBe(kind)
  })
})

describe("store registry", () => {
  it("exposes every agent exactly once, in detection order", () => {
    expect(agents.allStores().map((store) => store.kind)).toEqual(["codex", "copilot", "claude"])
  })

  it("owns no path outside every root", () => {
    const stray = join(fixtureRoot, "stray.jsonl")
    expect(agents.storeForPath(stray)).toBeNull()
    expect(agents.storeForPath(null)).toBeNull()
  })

  it("can be built over an injected table", () => {
    const fake = { kind: "codex", ownsPath: () => true } as unknown as AgentStore
    const registry = agents.createStoreRegistry({
      claude: fake,
      codex: fake,
      copilot: fake,
    })
    expect(registry.storeFor("claude")).toBe(fake)
    expect(registry.storeForPath("/anywhere")).toBe(fake)
    expect(registry.allStores()).toEqual([fake, fake, fake])
  })
})

describe("per-agent storage shapes", () => {
  it("keeps Claude resolution inside the requested project", async () => {
    const projects = sessionPaths.dirs.PROJECTS_DIR
    await Promise.all([
      mkdir(join(projects, "containment-a"), { recursive: true }),
      mkdir(join(projects, "containment-b"), { recursive: true }),
    ])
    await writeFile(join(projects, "containment-b", "other.jsonl"), "{}\n")
    const claude = agents.storeFor("claude")

    for (const [dirName, fileName] of [
      ["containment-a", "../containment-b/other.jsonl"],
      ["containment-a/../containment-b", "other.jsonl"],
      ["containment-a\\..\\containment-b", "other.jsonl"],
    ]) {
      await expect(claude.resolveSessionFile(dirName, fileName)).resolves.toBeNull()
    }
  })

  it("rejects a Claude project directory that canonically escapes the projects root", async () => {
    const outsideProject = join(fixtureRoot, "outside-project")
    await write(join(outsideProject, "session.jsonl"), "{}\n")
    await symlink(outsideProject, join(sessionPaths.dirs.PROJECTS_DIR, "project-alias"), "dir")

    await expect(agents.storeFor("claude").resolveSessionFile("project-alias", "session.jsonl"))
      .resolves.toBeNull()
  })

  it("keeps Codex rollout names relative to the sessions root and skips non-JSONL files", async () => {
    const root = agents.storeFor("codex").sessionsRoot() as string
    const relativeName = "2026/07/21/rollout-discovery.jsonl"
    await write(join(root, relativeName))
    await writeFile(join(root, "2026/07/21/ignored.txt"), "ignore me")

    const files = await agents.storeFor("codex").listSessionFiles()
    expect(files).toContainEqual(expect.objectContaining({
      filePath: join(root, relativeName),
      fileName: relativeName,
    }))
    expect(files.some((file) => file.fileName.endsWith("ignored.txt"))).toBe(false)
  })

  it("resolves the Codex home from the environment", () => {
    expect(agents.storeFor("codex").sessionsRoot())
      .toBe(join(resolve(fixtureRoot, "codex-home"), "sessions"))
    expect(agents.storeFor("copilot").sessionsRoot())
      .toBe(join(resolve(fixtureRoot, "copilot-home"), "session-state"))
  })

  it("accepts only the exact Copilot event-file shape", async () => {
    const sessionId = "7c0c2f28-4b5a-4a0f-9d1a-8e63b1f5c2aa"
    const root = agents.storeFor("copilot").sessionsRoot() as string
    await write(join(root, sessionId, "events.jsonl"), '{"type":"session.start"}\n')
    const copilot = agents.storeFor("copilot")
    const dirName = copilot.descriptor.dirName.encode("/work/project")

    await expect(copilot.resolveSessionFile(dirName, `${sessionId}/events.jsonl`))
      .resolves.toBe(join(root, sessionId, "events.jsonl"))
    for (const fileName of [
      `${sessionId}.jsonl`,
      `${sessionId}/../events.jsonl`,
      `${sessionId}\\events.jsonl`,
      "not-a-session/events.jsonl",
    ]) {
      await expect(copilot.resolveSessionFile(dirName, fileName)).resolves.toBeNull()
    }
  })

  it("lists only UUID-named Copilot session directories", async () => {
    const root = agents.storeFor("copilot").sessionsRoot() as string
    await write(join(root, "not-a-session", "events.jsonl"), "{}\n")

    const files = await agents.storeFor("copilot").listSessionFiles()
    expect(files.some((file) => file.fileName.startsWith("not-a-session/"))).toBe(false)
  })
})

describe("cross-agent lookup", () => {
  it("searches Claude first, then falls back to the other agents", async () => {
    const projects = sessionPaths.dirs.PROJECTS_DIR
    const codexRoot = agents.storeFor("codex").sessionsRoot() as string
    const claudePath = join(projects, "project-lookup", "shared-id.jsonl")
    const codexSharedPath = join(codexRoot, "2026/07/21/rollout-shared-id.jsonl")
    const codexOnlyPath = join(codexRoot, "2026/07/21/rollout-codex-only.jsonl")
    await Promise.all([
      write(claudePath, "{}\n"),
      write(codexSharedPath, "{}\n"),
      write(codexOnlyPath, "{}\n"),
    ])

    await expect(sessionPaths.findJsonlPath("shared-id")).resolves.toBe(claudePath)
    await expect(sessionPaths.findJsonlPath("codex-only")).resolves.toBe(codexOnlyPath)
    await expect(sessionPaths.findJsonlPath("missing-id")).resolves.toBeNull()
  })

  it("falls back to canonical Copilot event files and refuses traversal", async () => {
    const sessionId = "2b4b1e0e-6f34-4d21-8a4c-1f9e0c3d5b77"
    const root = agents.storeFor("copilot").sessionsRoot() as string
    const eventPath = join(root, sessionId, "events.jsonl")
    await write(eventPath, "{}\n")

    await expect(sessionPaths.findJsonlPath(sessionId)).resolves.toBe(eventPath)
    await expect(sessionPaths.findJsonlPath(`../${sessionId}`)).resolves.toBeNull()
    await expect(sessionPaths.findJsonlPath("not-a-uuid")).resolves.toBeNull()
  })

  it("finds the newest untracked Codex session for the requested working directory", async () => {
    const requestedCwd = "/work/requested"
    const root = agents.storeFor("codex").sessionsRoot() as string
    const matchingPath = join(root, "2026/07/21/rollout-matching-thread.jsonl")
    const otherPath = join(root, "2026/07/21/rollout-other-thread.jsonl")
    const startedAt = Date.now()
    await Promise.all([
      write(matchingPath, JSON.stringify({
        type: "session_meta",
        payload: { id: "matching-thread", cwd: requestedCwd },
      }) + "\n"),
      write(otherPath, JSON.stringify({
        type: "session_meta",
        payload: { id: "other-thread", cwd: "/work/other" },
      }) + "\n"),
    ])

    await expect(sessionPaths.findNewestCodexSessionForCwd(requestedCwd, new Set(), startedAt))
      .resolves.toEqual({
        filePath: matchingPath,
        fileName: "2026/07/21/rollout-matching-thread.jsonl",
        sessionId: "matching-thread",
      })
    await expect(
      sessionPaths.findNewestCodexSessionForCwd(requestedCwd, new Set([matchingPath]), startedAt),
    ).resolves.toBeNull()
  })

  it("reports every configured storage root once", () => {
    expect(sessionPaths.sessionStorageRoots().map((source) => source.kind))
      .toEqual(["codex", "copilot", "claude"])
  })
})
