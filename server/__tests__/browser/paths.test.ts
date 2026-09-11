// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertBrowserName,
  assertNamedBrowser,
  binDir,
  BrowserNameError,
  browserHome,
  DEFAULT_BROWSER,
  isThrowawayName,
  isValidBrowserName,
  isValidCogpitSessionId,
  NO_COGPIT_SESSION,
  pluginDir,
  profileDir,
  profilesDir,
  registryFile,
  runRoot,
  SHARED_RUN_NAME,
  sharedRunDir,
  shimPath,
  sweepOwnerFile,
  THROWAWAY_PREFIX,
} from "../../browser/paths"

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

describe("browser home", () => {
  it("defaults to ~/.cogpit/browser", () => {
    delete process.env.COGPIT_BROWSER_HOME
    expect(browserHome()).toBe(join(homedir(), ".cogpit", "browser"))
  })

  it("treats an empty COGPIT_BROWSER_HOME as unset", () => {
    process.env.COGPIT_BROWSER_HOME = ""
    expect(browserHome()).toBe(join(homedir(), ".cogpit", "browser"))
  })

  it("honours COGPIT_BROWSER_HOME", () => {
    expect(browserHome()).toBe(home)
  })

  it("keeps bin beside the home and everything else inside it", () => {
    expect(binDir()).toBe(join(root, "bin"))
    expect(shimPath("linux")).toBe(join(root, "bin", "agent-browser"))
    expect(shimPath("win32")).toBe(join(root, "bin", "agent-browser.cmd"))
    expect(profilesDir()).toBe(join(home, "profiles"))
    expect(profileDir("github")).toBe(join(home, "profiles", "github"))
    expect(runRoot()).toBe(join(home, "run"))
    expect(sharedRunDir()).toBe(join(home, "run", SHARED_RUN_NAME))
    expect(registryFile()).toBe(join(home, "sessions.json"))
    expect(pluginDir()).toBe(join(home, "plugin"))
    expect(sweepOwnerFile()).toBe(join(home, "sweeper.owner"))
  })
})

describe("constants", () => {
  it("names the default browser and the throwaway prefix", () => {
    expect(DEFAULT_BROWSER).toBe("default")
    expect(THROWAWAY_PREFIX).toBe("tmp-")
    expect(SHARED_RUN_NAME).toBe("shared")
  })

  it("uses a session-id sentinel the shim will refuse", () => {
    expect(isValidCogpitSessionId(NO_COGPIT_SESSION)).toBe(false)
  })
})

describe("isValidBrowserName", () => {
  it.each(["default", "github", "tmp-1", "a", "a_b-c9", "a".repeat(40)])("accepts %j", (name) => {
    expect(isValidBrowserName(name)).toBe(true)
  })

  it.each(["", "../x", "Foo", "a".repeat(41), "-x", "_x", "a b", "a/b", "a.b"])("rejects %j", (name) => {
    expect(isValidBrowserName(name)).toBe(false)
  })
})

describe("isThrowawayName", () => {
  it("is true only for the tmp- prefix", () => {
    expect(isThrowawayName("tmp-1")).toBe(true)
    expect(isThrowawayName("tmp-")).toBe(true)
    expect(isThrowawayName("tmp")).toBe(false)
    expect(isThrowawayName("default")).toBe(false)
    expect(isThrowawayName("xtmp-1")).toBe(false)
  })
})

describe("isValidCogpitSessionId", () => {
  it.each(["s1", "550e8400-e29b-41d4-a716-446655440000", "a_B-9", "x".repeat(80)])("accepts %j", (id) => {
    expect(isValidCogpitSessionId(id)).toBe(true)
  })

  it.each(["", "../x", "a/b", "a.b", "a b", "x".repeat(81)])("rejects %j", (id) => {
    expect(isValidCogpitSessionId(id)).toBe(false)
  })
})

describe("assertBrowserName", () => {
  it("returns for valid names including throwaways", () => {
    expect(() => assertBrowserName("default")).not.toThrow()
    expect(() => assertBrowserName("tmp-1")).not.toThrow()
  })

  it("throws BrowserNameError naming the rule", () => {
    expect(() => assertBrowserName("../x")).toThrow(BrowserNameError)
    expect(() => assertBrowserName("Foo")).toThrow(/\^\[a-z0-9\]\[a-z0-9_-\]\{0,39\}\$/)
    expect(() => assertBrowserName("")).toThrow(BrowserNameError)
  })
})

describe("assertNamedBrowser", () => {
  it("returns for valid non-throwaway names", () => {
    expect(() => assertNamedBrowser("default")).not.toThrow()
    expect(() => assertNamedBrowser("github")).not.toThrow()
  })

  it("throws for invalid syntax", () => {
    expect(() => assertNamedBrowser("../x")).toThrow(BrowserNameError)
  })

  it("throws for throwaway names", () => {
    expect(() => assertNamedBrowser("tmp-1")).toThrow(BrowserNameError)
    expect(() => assertNamedBrowser("tmp-1")).toThrow(/tmp-/)
  })
})

describe("path guards", () => {
  it("profileDir rejects invalid and throwaway names", () => {
    expect(() => profileDir("../x")).toThrow(BrowserNameError)
    expect(() => profileDir("tmp-1")).toThrow(BrowserNameError)
  })
})

describe("BrowserNameError", () => {
  it("is an Error with its own name", () => {
    const err = new BrowserNameError("nope")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("BrowserNameError")
    expect(err.message).toBe("nope")
  })
})
