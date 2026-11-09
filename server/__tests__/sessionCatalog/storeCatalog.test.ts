// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zstdCompressSync } from "node:zlib"
import { createClaudeStore } from "../../agents/claudeStore"
import { createCodexStore } from "../../agents/codexStore"
import { createCopilotStore } from "../../agents/copilotStore"
import type { AgentStore } from "../../agents/types"
import { subscribeCatalog, type CatalogChange } from "../../sessionCatalog/changes"
import { resetFacts } from "../../sessionCatalog/facts"
import {
  createStoreCatalog,
  disableSessionCatalogs,
  enableSessionCatalogs,
  type StoreCatalogSource,
} from "../../sessionCatalog/storeCatalog"

const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const ID_C = "33333333-3333-4333-8333-333333333333"

let home: string
const stores: AgentStore[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "session-catalog-"))
  resetFacts()
  enableSessionCatalogs()
})

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  disableSessionCatalogs()
  resetFacts()
  delete process.env.COGPIT_AGENT_WORKER
  rmSync(home, { recursive: true, force: true })
})

function claudeLine(sessionId: string, cwd: string, text = "hello"): string {
  return `${JSON.stringify({ type: "user", sessionId, cwd, timestamp: "2026-11-07T10:00:00.000Z", message: { role: "user", content: text } })}\n`
}

function codexLines(sessionId: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd, ...extra } })}\n`
}

/** Resolves with the next change the catalog publishes, or null after `ms`. */
function nextChange(ms = 3_000): Promise<CatalogChange | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { stop(); resolve(null) }, ms)
    const stop = subscribeCatalog((change) => { clearTimeout(timer); stop(); resolve(change) })
  })
}

/** Until the catalog's watchers are open: they are set up after the first listing, off the request. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

function claudeStore(): { store: AgentStore; root: string } {
  const root = join(home, "projects")
  mkdirSync(join(root, "-work-app"), { recursive: true })
  const store = createClaudeStore(root)
  stores.push(store)
  return { store, root }
}

describe("session catalog over a path-addressed store", () => {
  it("follows files being added, appended to, renamed and deleted", async () => {
    const { store, root } = claudeStore()
    const project = join(root, "-work-app")
    writeFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/app"))

    expect((await store.listTopLevelSessions()).map((s) => s.fileName)).toEqual([`${ID_A}.jsonl`])
    await settle()

    let change = nextChange()
    writeFileSync(join(project, `${ID_B}.jsonl`), claudeLine(ID_B, "/work/app"))
    expect((await change)?.kind).toBe("visible")
    expect((await store.listTopLevelSessions()).map((s) => s.fileName).sort()).toEqual([`${ID_A}.jsonl`, `${ID_B}.jsonl`])

    change = nextChange()
    appendFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/app", "more"))
    expect((await change)?.kind).toBe("touch")
    const appended = (await store.listTopLevelSessions()).find((s) => s.fileName === `${ID_A}.jsonl`)
    expect(appended?.size).toBe(statSync(join(project, `${ID_A}.jsonl`)).size)

    change = nextChange()
    renameSync(join(project, `${ID_B}.jsonl`), join(project, `${ID_C}.jsonl`))
    expect((await change)?.kind).toBe("visible")
    expect((await store.listTopLevelSessions()).map((s) => s.fileName).sort()).toEqual([`${ID_A}.jsonl`, `${ID_C}.jsonl`])
    expect(store.knownSessionFile(ID_C)).toBe(join(project, `${ID_C}.jsonl`))
    expect(store.knownSessionFile(ID_B)).toBeNull()

    change = nextChange()
    rmSync(join(project, `${ID_A}.jsonl`))
    expect((await change)?.kind).toBe("visible")
    expect((await store.listTopLevelSessions()).map((s) => s.fileName)).toEqual([`${ID_C}.jsonl`])
  })

  it("watches a project directory created after the first listing", async () => {
    const { store, root } = claudeStore()
    expect(await store.listTopLevelSessions()).toEqual([])
    await settle()

    const change = nextChange()
    mkdirSync(join(root, "-work-new"))
    writeFileSync(join(root, "-work-new", `${ID_A}.jsonl`), claudeLine(ID_A, "/work/new"))
    await change
    // The new directory is listed on its parent's event; the file may land with it or on the next one.
    await vi.waitFor(async () => {
      expect((await store.listTopLevelSessions()).map((s) => s.dirName)).toEqual(["-work-new"])
    })
    const second = nextChange()
    appendFileSync(join(root, "-work-new", `${ID_A}.jsonl`), claudeLine(ID_A, "/work/new", "again"))
    expect(await second).not.toBeNull()
  })

  it("names each project by the cwd at the head of its newest session, read once per file", async () => {
    const { store, root } = claudeStore()
    const project = join(root, "-work-app")
    writeFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/my-app"))
    const [project1] = await store.listProjects()
    expect(project1).toMatchObject({ dirName: "-work-app", path: "/work/my-app", sessionCount: 1 })
  })

  it("lists one project's files from the catalog without reading the directory again", async () => {
    const { store, root } = claudeStore()
    const project = join(root, "-work-app")
    writeFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/app"))
    await store.listTopLevelSessions()
    const files = await store.listProjectSessionFiles("-work-app")
    expect(files?.map((file) => file.fileName)).toEqual([`${ID_A}.jsonl`])
  })
})

/** A source over `root/<project>/<id>.jsonl` whose reads are counted. */
function countingSource(root: string, identity?: StoreCatalogSource["readIdentity"]) {
  const calls = { listDir: 0, readIdentity: 0 }
  const source: StoreCatalogSource = {
    root: () => root,
    async listDir(_root, dir, depth) {
      calls.listDir += 1
      const { readdirSync, statSync: stat } = await import("node:fs")
      if (depth === 0) return { files: [], dirs: readdirSync(dir).map((name) => join(dir, name)) }
      return {
        files: readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => {
          const info = stat(join(dir, name))
          return { filePath: join(dir, name), fileName: name, dirName: identity ? null : "p", mtimeMs: info.mtimeMs, size: info.size }
        }),
        dirs: [],
      }
    },
    sessionIdOf: (fileName) => fileName.replace(/\.jsonl$/, ""),
    encodeDirName: (cwd) => cwd.replaceAll("/", "-"),
    decodeDirName: () => null,
    readIdentity: async (filePath) => {
      calls.readIdentity += 1
      return identity ? identity(filePath) : null
    },
    readSessionMeta: async () => { throw new Error("no full reads here") },
    identityIsFinal: (_filePath, size) => size > 64,
  }
  return { source, calls }
}

describe("session catalog reads", () => {
  it("does not walk or re-read identities on a repeated listing once watching", async () => {
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    writeFileSync(join(root, "p", "a.jsonl"), "x".repeat(100))
    const { source, calls } = countingSource(root, async () => ({ sessionId: "a", cwd: "/w", gitBranch: "", isSubagent: false, parentSessionId: null }))
    const catalog = createStoreCatalog(source)
    try {
      await catalog.topLevelSessions()
      await settle()
      await vi.waitFor(() => expect(calls.listDir).toBeGreaterThanOrEqual(4))
      await new Promise((resolve) => setTimeout(resolve, 50))
      const before = { ...calls }
      for (let i = 0; i < 5; i += 1) await catalog.topLevelSessions()
      await catalog.projects()
      expect(calls).toEqual(before)
    } finally {
      catalog.close()
    }
  })

  it("keeps a final identity across appends and reads a non-final one again", async () => {
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    const big = join(root, "p", "big.jsonl")
    const small = join(root, "p", "small.jsonl")
    writeFileSync(big, "x".repeat(100))
    writeFileSync(small, "x")
    const { source, calls } = countingSource(root, async (filePath) => ({ sessionId: "", cwd: `/w/${filePath.endsWith("big.jsonl") ? "big" : "small"}`, gitBranch: "", isSubagent: false, parentSessionId: null }))
    const catalog = createStoreCatalog(source)
    try {
      await catalog.topLevelSessions()
      expect(calls.readIdentity).toBe(2)
      await settle()
      const change = nextChange()
      appendFileSync(big, "more")
      appendFileSync(small, "more")
      await change
      await catalog.topLevelSessions()
      expect(calls.readIdentity).toBe(3)
    } finally {
      catalog.close()
    }
  })

  it("reads an identity again when its file shrinks, as a rewrite does", async () => {
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    const file = join(root, "p", "a.jsonl")
    writeFileSync(file, "x".repeat(100))
    let cwd = "/w/first"
    const { source } = countingSource(root, async () => ({ sessionId: "a", cwd, gitBranch: "", isSubagent: false, parentSessionId: null }))
    const catalog = createStoreCatalog(source)
    try {
      expect((await catalog.topLevelSessions())[0]?.projectPath).toBe("/w/first")
      await settle()
      cwd = "/w/second"
      const change = nextChange()
      writeFileSync(file, "x".repeat(80))
      await change
      expect((await catalog.topLevelSessions())[0]?.projectPath).toBe("/w/second")
    } finally {
      catalog.close()
    }
  })

  it("walks on every read and keeps nothing in an agent worker process", async () => {
    process.env.COGPIT_AGENT_WORKER = "1"
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    writeFileSync(join(root, "p", "a.jsonl"), "x")
    const { source, calls } = countingSource(root)
    const catalog = createStoreCatalog(source)
    await catalog.topLevelSessions()
    await catalog.topLevelSessions()
    expect(calls.listDir).toBe(4)
    expect(catalog.sessionFileFor("a")).toBeNull()
  })

  it("walks on every read before the catalog is started", async () => {
    disableSessionCatalogs()
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    writeFileSync(join(root, "p", "a.jsonl"), "x")
    const { source, calls } = countingSource(root)
    const catalog = createStoreCatalog(source)
    await catalog.topLevelSessions()
    await catalog.topLevelSessions()
    expect(calls.listDir).toBe(4)
    expect(catalog.sessionFileFor("a")).toBeNull()
  })
})

describe("session catalog over the dated rollout tree", () => {
  function codexStore(): { store: AgentStore; day: string } {
    const day = join(home, "codex", "sessions", "2026", "11", "07")
    mkdirSync(day, { recursive: true })
    const store = createCodexStore(join(home, "codex"))
    stores.push(store)
    return { store, day }
  }

  it("keeps a rollout's address when it is compressed beside its plain form", async () => {
    const { store, day } = codexStore()
    const name = `rollout-2026-11-07T10-00-00-${ID_A}.jsonl`
    const plain = join(day, name)
    writeFileSync(plain, codexLines(ID_A, "/work/app"))
    const [listed] = await store.listTopLevelSessions()
    expect(listed).toMatchObject({ fileName: `2026/11/07/${name}`, filePath: plain, projectPath: "/work/app" })
    await settle()

    // Mid-compression both exist and the plain one is current.
    let change = nextChange()
    writeFileSync(`${plain}.zst`, zstdCompressSync(Buffer.from(codexLines(ID_A, "/work/app"))))
    await change
    expect((await store.listTopLevelSessions()).map((s) => s.filePath)).toEqual([plain])

    change = nextChange()
    rmSync(plain)
    await change
    await vi.waitFor(async () => {
      const sessions = await store.listTopLevelSessions()
      expect(sessions.map((s) => [s.filePath, s.fileName])).toEqual([[`${plain}.zst`, `2026/11/07/${name}`]])
    })
  })

  it("leaves sub-agent rollouts out of the top level but lists them under their parent", async () => {
    const { store, day } = codexStore()
    writeFileSync(join(day, `rollout-2026-11-07T10-00-00-${ID_A}.jsonl`), codexLines(ID_A, "/work/app"))
    writeFileSync(
      join(day, `rollout-2026-11-07T10-00-01-${ID_B}.jsonl`),
      codexLines(ID_B, "/work/app", { source: { subagent: { thread_spawn: { parent_thread_id: ID_A } } } }),
    )
    expect((await store.listTopLevelSessions()).map((s) => s.sessionId)).toEqual([ID_A])
    expect((await store.listSubagentFiles("", ID_A))?.map((file) => file.agentId)).toEqual([ID_B])
    const [project] = await store.listProjects()
    expect(project).toMatchObject({ path: "/work/app", sessionCount: 1 })
  })
})

describe("restarted mtimes", () => {
  it("re-stats a file whose mtime moves without a size change", async () => {
    const { store, root } = claudeStore()
    const file = join(root, "-work-app", `${ID_A}.jsonl`)
    writeFileSync(file, claudeLine(ID_A, "/work/app"))
    await store.listTopLevelSessions()
    await settle()
    const change = nextChange()
    utimesSync(file, new Date(), new Date(Date.now() + 60_000))
    await change
    const [session] = await store.listTopLevelSessions()
    expect(session.mtimeMs).toBe(statSync(file).mtimeMs)
  })
})

describe("review fixes (perf/session-list @ cf7f7f18)", () => {
  it("does not report untouched files as written when their directory is listed again", async () => {
    const { store, root } = claudeStore()
    const project = join(root, "-work-app")
    writeFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/app"))
    await store.listTopLevelSessions()
    await settle()
    const change = nextChange(800)
    // A session's tool-results directory appears beside the transcripts.
    mkdirSync(join(project, ID_A))
    expect(await change).toBeNull()
  })

  it("watches a directory created while the watchers are still being opened", async () => {
    const { store, root } = claudeStore()
    for (let i = 0; i < 150; i += 1) mkdirSync(join(root, `-work-p${i}`))
    await store.listTopLevelSessions()
    mkdirSync(join(root, "-work-late"))
    writeFileSync(join(root, "-work-late", `${ID_A}.jsonl`), claudeLine(ID_A, "/work/late"))
    await vi.waitFor(async () => {
      expect((await store.listTopLevelSessions()).map((s) => s.dirName)).toEqual(["-work-late"])
    }, { timeout: 3_000 })
    await settle()
    const change = nextChange()
    appendFileSync(join(root, "-work-late", `${ID_A}.jsonl`), claudeLine(ID_A, "/work/late", "more"))
    expect(await change).not.toBeNull()
  })

  it("keeps watching a project directory deleted and created again within one debounce", async () => {
    const { store, root } = claudeStore()
    const project = join(root, "-work-app")
    writeFileSync(join(project, `${ID_A}.jsonl`), claudeLine(ID_A, "/work/app"))
    await store.listTopLevelSessions()
    await settle()
    let change = nextChange()
    rmSync(project, { recursive: true })
    mkdirSync(project)
    writeFileSync(join(project, `${ID_B}.jsonl`), claudeLine(ID_B, "/work/app"))
    await change
    await vi.waitFor(async () => {
      expect((await store.listTopLevelSessions()).map((s) => s.fileName)).toEqual([`${ID_B}.jsonl`])
    })
    await settle()
    change = nextChange()
    appendFileSync(join(project, `${ID_B}.jsonl`), claudeLine(ID_B, "/work/app", "more"))
    expect((await change)?.kind).toBe("touch")
  })

  it("starts watching a root created after the first listing, without waiting for the backstop", async () => {
    const store = createCodexStore(join(home, "codex"))
    stores.push(store)
    expect(await store.listTopLevelSessions()).toEqual([])
    await settle()
    const day = join(home, "codex", "sessions", "2026", "11", "08")
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-11-08T10-00-00-${ID_A}.jsonl`), codexLines(ID_A, "/work/app"))
    await vi.waitFor(async () => {
      expect((await store.listTopLevelSessions()).map((s) => s.sessionId)).toEqual([ID_A])
    }, { timeout: 3_000 })
    // Watched now: a write is announced by an event.
    await vi.waitFor(async () => {
      const change = nextChange(500)
      appendFileSync(join(day, `rollout-2026-11-08T10-00-00-${ID_A}.jsonl`), codexLines(ID_A, "/work/app"))
      expect(await change).not.toBeNull()
    }, { timeout: 5_000 })
  })

  it("reads a Copilot identity again when only its workspace sidecar changed", async () => {
    const sessionDir = join(home, "copilot", "session-state", ID_A)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "events.jsonl"), `${JSON.stringify({ type: "session.start", data: { sessionId: ID_A } })}\n`)
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /work/first\nbranch: main\n")
    const store = createCopilotStore(join(home, "copilot"))
    stores.push(store)
    expect((await store.listTopLevelSessions())[0]?.projectPath).toBe("/work/first")
    await settle()
    const change = nextChange()
    writeFileSync(join(sessionDir, "workspace.yaml"), "cwd: /work/second\nbranch: main\n")
    expect((await change)?.kind).toBe("visible")
    expect((await store.listTopLevelSessions())[0]?.projectPath).toBe("/work/second")
  })

  it("ignores a walk that started before the root changed", async () => {
    const roots = { a: join(home, "a"), b: join(home, "b") }
    for (const root of Object.values(roots)) mkdirSync(join(root, "p"), { recursive: true })
    writeFileSync(join(roots.a, "p", "old.jsonl"), "x")
    writeFileSync(join(roots.b, "p", "new.jsonl"), "x")
    let current = roots.a
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const { source } = countingSource(roots.a)
    const listDir = source.listDir
    const catalog = createStoreCatalog({
      ...source,
      root: () => current,
      async listDir(root, dir, depth) {
        if (root === roots.a) await gateA
        return listDir(root, dir, depth)
      },
    })
    try {
      const first = catalog.topLevelSessions()
      current = roots.b
      expect((await catalog.topLevelSessions()).map((s) => s.fileName)).toEqual(["new.jsonl"])
      releaseA()
      await first
      expect((await catalog.topLevelSessions()).map((s) => s.fileName)).toEqual(["new.jsonl"])
    } finally {
      catalog.close()
    }
  })

  it("shares one walk between concurrent reads before the catalog runs, and lists files without identities", async () => {
    disableSessionCatalogs()
    const root = join(home, "root")
    mkdirSync(join(root, "p"), { recursive: true })
    writeFileSync(join(root, "p", "a.jsonl"), "x")
    const { source, calls } = countingSource(root, async () => ({ sessionId: "a", cwd: "/w", gitBranch: "", isSubagent: false, parentSessionId: null }))
    const catalog = createStoreCatalog(source)
    await Promise.all([catalog.topLevelSessions(), catalog.topLevelSessions(), catalog.projects()])
    expect(calls).toEqual({ listDir: 2, readIdentity: 1 })
    await Promise.all([catalog.files(), catalog.files()])
    expect(calls).toEqual({ listDir: 4, readIdentity: 1 })
  })
})
