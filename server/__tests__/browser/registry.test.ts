// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserNameError, NO_COGPIT_SESSION, profileDir, profilesDir, registryFile } from "../../browser/paths"
import {
  BrowserExistsError,
  BrowserNotFoundError,
  createBrowser,
  listBrowsers,
  readBrowser,
  readRegistry,
  removeBrowser,
  touchLastUrl,
  updateBrowser,
  writeRegistry,
} from "../../browser/registry"

let root = ""
let home = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  home = join(root, "browser")
  process.env.COGPIT_BROWSER_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

const neverRunning = async () => false

function writeDriver(name: string, content: string, mtime?: Date): string {
  mkdirSync(profileDir(name), { recursive: true })
  const path = join(profileDir(name), ".driver")
  writeFileSync(path, content)
  if (mtime) utimesSync(path, mtime, mtime)
  return path
}

function readRegistryFile(): unknown {
  return JSON.parse(readFileSync(registryFile(), "utf8"))
}

describe("readRegistry", () => {
  it("returns the empty shape when the file is missing", () => {
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
  })

  it("returns the empty shape for an empty file", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(registryFile(), "")
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
  })

  it("returns the empty shape for a corrupt file", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(registryFile(), "{ not json")
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
  })

  it("returns the empty shape when the JSON is not a registry", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(registryFile(), JSON.stringify([1, 2, 3]))
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
    writeFileSync(registryFile(), JSON.stringify({ version: 1, sessions: "nope" }))
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
  })

  it("returns the empty shape for an unknown version", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(registryFile(), JSON.stringify({ version: 2, sessions: { github: { createdAt: "2026-09-06T10:00:00.000Z" } } }))
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
    writeFileSync(registryFile(), JSON.stringify({ sessions: { github: { createdAt: "2026-09-06T10:00:00.000Z" } } }))
    expect(readRegistry()).toEqual({ version: 1, sessions: {} })
  })

  it("drops entries whose names are not named browsers", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        sessions: {
          github: { createdAt: "2026-09-06T10:00:00.000Z" },
          "tmp-x": { createdAt: "2026-09-06T10:00:00.000Z" },
          "../x": { createdAt: "2026-09-06T10:00:00.000Z" },
          Foo: { createdAt: "2026-09-06T10:00:00.000Z" },
          broken: "not an entry",
        },
      }),
    )
    expect(readRegistry()).toEqual({
      version: 1,
      sessions: { github: { createdAt: "2026-09-06T10:00:00.000Z" } },
    })
  })
})

describe("writeRegistry", () => {
  it("creates the home and round-trips through readRegistry", () => {
    const registry = {
      version: 1 as const,
      sessions: { github: { note: "GitHub", createdAt: "2026-09-06T10:00:00.000Z", lastUrl: "https://github.com" } },
    }
    writeRegistry(registry)
    expect(existsSync(home)).toBe(true)
    expect(readRegistry()).toEqual(registry)
  })

  it("pretty-prints and leaves no temp file behind", () => {
    writeRegistry({ version: 1, sessions: {} })
    expect(readFileSync(registryFile(), "utf8")).toBe('{\n  "version": 1,\n  "sessions": {}\n}\n')
    expect(readdirSync(home)).toEqual(["sessions.json"])
  })
})

describe("listBrowsers", () => {
  it("lists only default (not running) for an empty home", async () => {
    await expect(listBrowsers(neverRunning)).resolves.toEqual([
      {
        name: "default",
        isDefault: true,
        running: false,
        note: null,
        createdAt: null,
        lastUsedAt: null,
        lastUrl: null,
        driverSessionId: null,
      },
    ])
  })

  it("includes a profile dir that has no registry entry", async () => {
    mkdirSync(profileDir("github"), { recursive: true })
    const names = (await listBrowsers(neverRunning)).map((session) => session.name)
    expect(names).toEqual(["default", "github"])
  })

  it("includes a registry entry that has no profile dir", async () => {
    writeRegistry({ version: 1, sessions: { docs: { note: "Docs", createdAt: "2026-09-06T10:00:00.000Z" } } })
    const sessions = await listBrowsers(neverRunning)
    expect(sessions.map((session) => session.name)).toEqual(["default", "docs"])
    expect(sessions[1]).toMatchObject({ note: "Docs", createdAt: "2026-09-06T10:00:00.000Z", lastUrl: null })
  })

  it("ignores throwaway, invalid and non-directory entries under profiles", async () => {
    mkdirSync(join(profilesDir(), "tmp-x"), { recursive: true })
    mkdirSync(join(profilesDir(), "Foo"), { recursive: true })
    mkdirSync(join(profilesDir(), "github"), { recursive: true })
    writeFileSync(join(profilesDir(), "stray"), "")
    const names = (await listBrowsers(neverRunning)).map((session) => session.name)
    expect(names).toEqual(["default", "github"])
  })

  it("asks isRunning for every name", async () => {
    mkdirSync(profileDir("github"), { recursive: true })
    const isRunning = vi.fn(async (name: string) => name === "github")
    const sessions = await listBrowsers(isRunning)
    expect(isRunning.mock.calls.map(([name]) => name).sort()).toEqual(["default", "github"])
    expect(sessions.find((session) => session.name === "github")?.running).toBe(true)
    expect(sessions.find((session) => session.name === "default")?.running).toBe(false)
  })

  it("treats a rejecting isRunning as not running without sinking the list", async () => {
    mkdirSync(profileDir("github"), { recursive: true })
    mkdirSync(profileDir("docs"), { recursive: true })
    const isRunning = async (name: string) => {
      if (name === "github") throw new Error("daemon probe failed")
      return name === "docs"
    }
    const sessions = await listBrowsers(isRunning)
    expect(sessions.map((session) => [session.name, session.running])).toEqual([
      ["default", false],
      ["docs", true],
      ["github", false],
    ])
  })

  it("parses .driver into lastUsedAt and driverSessionId", async () => {
    const when = new Date("2026-09-06T12:34:56.000Z")
    const path = writeDriver("default", "sess-123\n", when)
    const [session] = await listBrowsers(neverRunning)
    expect(session.driverSessionId).toBe("sess-123")
    expect(session.lastUsedAt).toBe(statSync(path).mtime.toISOString())
    expect(session.lastUsedAt).toBe(when.toISOString())
  })

  it("attributes nothing to a spawn that owns no session", async () => {
    // What the shim writes when Cogpit passed NO_COGPIT_SESSION: a browser a
    // shared app-server touched must not read as driven by a real session.
    writeDriver("default", `${NO_COGPIT_SESSION}\n`)
    const [session] = await listBrowsers(neverRunning)
    expect(session.driverSessionId).toBeNull()
    expect(session.lastUsedAt).not.toBeNull()
  })

  it.each(["\n", "../x\n", "not a session id\n", `${"x".repeat(81)}\n`])(
    "reports .driver content %j as no driver but still used",
    async (content) => {
      writeDriver("default", content)
      const [session] = await listBrowsers(neverRunning)
      expect(session.driverSessionId).toBeNull()
      expect(session.lastUsedAt).not.toBeNull()
    },
  )

  it("orders default first, then lastUsedAt descending with nulls last, then name", async () => {
    writeDriver("older", "a", new Date("2026-09-01T00:00:00.000Z"))
    writeDriver("newest", "b", new Date("2026-09-03T00:00:00.000Z"))
    writeDriver("middle", "c", new Date("2026-09-02T00:00:00.000Z"))
    writeDriver("default", "d", new Date("2026-08-01T00:00:00.000Z"))
    mkdirSync(profileDir("zed"), { recursive: true })
    mkdirSync(profileDir("alpha"), { recursive: true })
    const names = (await listBrowsers(neverRunning)).map((session) => session.name)
    expect(names).toEqual(["default", "newest", "middle", "older", "alpha", "zed"])
  })
})

describe("readBrowser", () => {
  it("describes one browser the way listBrowsers does", async () => {
    createBrowser("github", "GitHub")
    writeDriver("github", "sess-123\n")
    const [listed] = (await listBrowsers(neverRunning)).filter((session) => session.name === "github")
    expect(await readBrowser("github", neverRunning)).toEqual(listed)
  })

  it("reports a browser that has neither entry nor profile", async () => {
    expect(await readBrowser("ghost", neverRunning)).toMatchObject({
      name: "ghost",
      running: false,
      note: null,
      createdAt: null,
      lastUsedAt: null,
    })
  })

  it("asks isRunning for the name and tolerates a rejection", async () => {
    const isRunning = vi.fn(async (name: string) => name === "github")
    expect(await readBrowser("github", isRunning)).toMatchObject({ running: true })
    expect(isRunning).toHaveBeenCalledWith("github")
    expect(await readBrowser("github", async () => { throw new Error("probe failed") }))
      .toMatchObject({ running: false })
  })

  it("throws BrowserNameError for invalid and throwaway names", async () => {
    await expect(readBrowser("../x", neverRunning)).rejects.toBeInstanceOf(BrowserNameError)
    await expect(readBrowser("tmp-1", neverRunning)).rejects.toBeInstanceOf(BrowserNameError)
  })
})

describe("createBrowser", () => {
  it("creates the profile dir and registry entry and returns the session", () => {
    const before = Date.now()
    const session = createBrowser("github", "GitHub")
    expect(existsSync(profileDir("github"))).toBe(true)
    expect(session).toMatchObject({
      name: "github",
      isDefault: false,
      running: false,
      note: "GitHub",
      lastUsedAt: null,
      lastUrl: null,
      driverSessionId: null,
    })
    expect(Date.parse(session.createdAt ?? "")).toBeGreaterThanOrEqual(before)
    expect(readRegistryFile()).toEqual({
      version: 1,
      sessions: { github: { note: "GitHub", createdAt: session.createdAt } },
    })
  })

  it("omits the note when none is given", () => {
    const session = createBrowser("github")
    expect(session.note).toBeNull()
    expect(readRegistry().sessions.github).not.toHaveProperty("note")
  })

  it("round-trips a browser named constructor", async () => {
    expect(createBrowser("constructor").name).toBe("constructor")
    expect(() => createBrowser("constructor")).toThrow(BrowserExistsError)
    touchLastUrl("constructor", "https://example.com")
    const sessions = await listBrowsers(neverRunning)
    expect(sessions.map((session) => session.name)).toEqual(["default", "constructor"])
    expect(sessions[1].lastUrl).toBe("https://example.com")
    expect(Object.keys(readRegistry().sessions)).toEqual(["constructor"])
  })

  it("throws BrowserExistsError when the profile dir exists", () => {
    mkdirSync(profileDir("github"), { recursive: true })
    expect(() => createBrowser("github")).toThrow(BrowserExistsError)
  })

  it("throws BrowserExistsError when the registry entry exists", () => {
    writeRegistry({ version: 1, sessions: { github: { createdAt: "2026-09-06T10:00:00.000Z" } } })
    expect(() => createBrowser("github")).toThrow(BrowserExistsError)
    expect(existsSync(profileDir("github"))).toBe(false)
  })

  it("throws BrowserExistsError for default, which always exists", () => {
    expect(() => createBrowser("default")).toThrow(BrowserExistsError)
  })

  it("throws BrowserNameError for invalid and throwaway names", () => {
    expect(() => createBrowser("../x")).toThrow(BrowserNameError)
    expect(() => createBrowser("Foo")).toThrow(BrowserNameError)
    expect(() => createBrowser("tmp-x")).toThrow(BrowserNameError)
    expect(existsSync(registryFile())).toBe(false)
  })
})

describe("updateBrowser", () => {
  it("patches note and lastUrl on an existing entry", () => {
    createBrowser("github", "GitHub")
    updateBrowser("github", { lastUrl: "https://github.com" })
    expect(readRegistry().sessions.github).toMatchObject({ note: "GitHub", lastUrl: "https://github.com" })
    updateBrowser("github", { note: "Work GitHub" })
    expect(readRegistry().sessions.github).toMatchObject({ note: "Work GitHub", lastUrl: "https://github.com" })
  })

  it("creates the entry for default, which always exists", () => {
    const before = Date.now()
    updateBrowser("default", { note: "Shared" })
    const entry = readRegistry().sessions.default
    expect(entry.note).toBe("Shared")
    expect(Date.parse(entry.createdAt)).toBeGreaterThanOrEqual(before)
  })

  it("creates the entry for a browser that only has a profile dir", () => {
    mkdirSync(profileDir("github"), { recursive: true })
    updateBrowser("github", { note: "GitHub" })
    expect(readRegistry().sessions.github.note).toBe("GitHub")
  })

  it("throws BrowserNotFoundError when neither entry nor profile dir exists", () => {
    expect(() => updateBrowser("github", { note: "GitHub" })).toThrow(BrowserNotFoundError)
    expect(existsSync(registryFile())).toBe(false)
  })

  it("clears the note with null", () => {
    createBrowser("github", "GitHub")
    updateBrowser("github", { note: null })
    expect(readRegistry().sessions.github).not.toHaveProperty("note")
  })

  it("throws BrowserNameError for invalid and throwaway names", () => {
    expect(() => updateBrowser("../x", { note: "x" })).toThrow(BrowserNameError)
    expect(() => updateBrowser("tmp-x", { note: "x" })).toThrow(BrowserNameError)
  })
})

describe("removeBrowser", () => {
  it("deletes the profile dir and registry entry", () => {
    createBrowser("github", "GitHub")
    createBrowser("docs")
    writeDriver("github", "sess")
    removeBrowser("github")
    expect(existsSync(profileDir("github"))).toBe(false)
    expect(Object.keys(readRegistry().sessions)).toEqual(["docs"])
  })

  it("tolerates a browser that only exists in one place", () => {
    mkdirSync(profileDir("github"), { recursive: true })
    expect(() => removeBrowser("github")).not.toThrow()
    expect(existsSync(profileDir("github"))).toBe(false)
    expect(() => removeBrowser("missing")).not.toThrow()
  })

  it("throws BrowserNameError for default", () => {
    expect(() => removeBrowser("default")).toThrow(BrowserNameError)
  })

  it("throws BrowserNameError for invalid and throwaway names", () => {
    expect(() => removeBrowser("../x")).toThrow(BrowserNameError)
    expect(() => removeBrowser("tmp-x")).toThrow(BrowserNameError)
  })
})

describe("touchLastUrl", () => {
  it("records the url for default, creating the entry when absent", () => {
    touchLastUrl("default", "https://example.com")
    expect(readRegistry().sessions.default.lastUrl).toBe("https://example.com")
  })

  it("records the url for a browser that only has a profile dir", () => {
    mkdirSync(profileDir("github"), { recursive: true })
    touchLastUrl("github", "https://github.com")
    expect(readRegistry().sessions.github.lastUrl).toBe("https://github.com")
  })

  it("does not create an entry for a browser with neither entry nor profile dir", () => {
    touchLastUrl("github", "https://github.com")
    expect(existsSync(registryFile())).toBe(false)
  })

  it("skips the write when the url is unchanged", () => {
    touchLastUrl("default", "https://example.com")
    const before = statSync(registryFile())
    utimesSync(registryFile(), new Date(0), new Date(0))
    touchLastUrl("default", "https://example.com")
    expect(statSync(registryFile()).mtimeMs).toBe(0)
    expect(statSync(registryFile()).size).toBe(before.size)
  })

  it("ignores invalid and throwaway names without writing", () => {
    expect(() => touchLastUrl("../x", "https://example.com")).not.toThrow()
    expect(() => touchLastUrl("Foo", "https://example.com")).not.toThrow()
    expect(() => touchLastUrl("tmp-x", "https://example.com")).not.toThrow()
    expect(existsSync(registryFile())).toBe(false)
    expect(existsSync(home)).toBe(false)
  })
})
