// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { noteBrowserProfiles, reapBrowserProfileNotes } from "../../browser/owners"
import { ownersDir } from "../../browser/paths"
import { __resetEditionForTest, PERSONAL_EDITION, type EditionBrowsers } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"

const HOUR_MS = 60 * 60 * 1000

let root = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-owners-"))
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
})

afterEach(() => {
  __resetEditionForTest()
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

function installProfiles(profileForSession: EditionBrowsers["profileForSession"]): void {
  installFakeEdition({ browsers: { ...PERSONAL_EDITION.browsers, profileForSession } })
}

function note(file: string): string | null {
  const path = join(ownersDir(), file)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function writeNote(file: string, profile: string, ageMs = 0): void {
  mkdirSync(ownersDir(), { recursive: true })
  const path = join(ownersDir(), file)
  writeFileSync(path, `${profile}\n`)
  const at = new Date(Date.now() - ageMs)
  utimesSync(path, at, at)
}

describe("noteBrowserProfiles", () => {
  it("writes nothing in personal edition, and drops notes a previous run left", () => {
    writeNote("s1", "user-u_alice")
    writeNote(".unowned", "user-unassigned")

    noteBrowserProfiles("s1")

    expect(readdirSync(ownersDir())).toEqual([])
  })

  it("names the session's own profile, and the one for agents no note names", () => {
    installProfiles((sessionId) => (sessionId === "s1" ? "user-u_alice" : "user-unassigned"))

    noteBrowserProfiles("s1")

    expect(note("s1")).toBe("user-u_alice\n")
    expect(note(".unowned")).toBe("user-unassigned\n")
  })

  it("gives an id that is not a session's no note of its own", () => {
    installProfiles(() => "user-unassigned")

    noteBrowserProfiles("")

    expect(readdirSync(ownersDir())).toEqual([".unowned"])
  })

  it("writes no note the shim would refuse to follow", () => {
    for (const profile of ["default", "tmp-1", "../escape", "Upper"]) {
      installProfiles(() => profile)
      noteBrowserProfiles("s1")
      expect(note("s1"), profile).toBeNull()
      __resetEditionForTest()
    }
  })

  it("dates an unchanged note afresh, so the sweeper keeps a session that just started", () => {
    installProfiles(() => "user-u_alice")
    writeNote("s1", "user-u_alice", 2 * HOUR_MS)

    noteBrowserProfiles("s1")
    reapBrowserProfileNotes(() => false)

    expect(note("s1")).toBe("user-u_alice\n")
  })
})

describe("reapBrowserProfileNotes", () => {
  it("drops the notes of sessions neither live nor started within the hour, and nothing else", () => {
    writeNote("finished", "user-u_alice", 2 * HOUR_MS)
    writeNote("recent", "user-u_alice", 10 * 60 * 1000)
    writeNote("running", "user-u_alice", 2 * HOUR_MS)
    writeNote(".unowned", "user-unassigned", 2 * HOUR_MS)

    reapBrowserProfileNotes((id) => id === "running")

    expect(readdirSync(ownersDir()).sort()).toEqual([".unowned", "recent", "running"])
  })

  it("does nothing without a notes directory", () => {
    expect(() => reapBrowserProfileNotes(() => false)).not.toThrow()
  })
})
