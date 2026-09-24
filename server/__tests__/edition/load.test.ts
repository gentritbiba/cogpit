// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  editionModule,
  getEdition,
  installEdition,
  loadEdition,
  PERSONAL_EDITION,
  __resetEditionForTest,
  type EditionModule,
} from "../../edition"

const TEAM: EditionModule = { ...PERSONAL_EDITION, edition: "team" }
const teamPackage = () => vi.fn(async () => ({ default: TEAM }))

const LOADER = "/app/server/edition/load.ts"
const INSTALLED_TEAM = "/app/node_modules/@cogpit/team/index.ts"

/** Bun names the specifier it could not resolve on the error. */
function bunNotFound(specifier: string, referrer: string): Error {
  return Object.assign(new Error(`Cannot find module '${specifier}' from '${referrer}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    specifier,
  })
}

/** Node only says it in the message. */
function nodeNotFound(specifier: string, referrer: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from ${referrer}`), {
    code: "ERR_MODULE_NOT_FOUND",
  })
}

function loadTeamFrom(importTeam: () => Promise<unknown>) {
  return loadEdition({ shell: "standalone", configEdition: "team" }, importTeam)
}

const originalEnv = process.env.COGPIT_EDITION

beforeEach(() => {
  delete process.env.COGPIT_EDITION
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEnv
  __resetEditionForTest()
})

describe("edition registry", () => {
  it("runs personal edition until one is installed", () => {
    expect(getEdition()).toBe("personal")
    expect(getEdition()).toBe("personal")
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it("installs an edition once per process", () => {
    installEdition(TEAM)
    expect(editionModule()).toBe(TEAM)
    expect(getEdition()).toBe("team")
    expect(() => installEdition({ ...TEAM })).toThrow("already installed")
  })

  it("returns to personal after __resetEditionForTest", () => {
    installEdition(TEAM)
    __resetEditionForTest()
    expect(getEdition()).toBe("personal")
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })
})

describe("loadEdition", () => {
  it("loads the team package when the standalone shell resolves team from the environment", async () => {
    process.env.COGPIT_EDITION = "team"
    const importTeam = teamPackage()
    await expect(loadEdition({ shell: "standalone" }, importTeam)).resolves.toBe("team")
    expect(editionModule()).toBe(TEAM)
    expect(importTeam).toHaveBeenCalledOnce()
  })

  it("loads it for a team config edition too", async () => {
    await expect(loadEdition({ shell: "standalone", configEdition: "team" }, teamPackage())).resolves.toBe("team")
    expect(getEdition()).toBe("team")
  })

  it.each(["electron", "dev"] as const)("never asks for the package in the %s shell", async (shell) => {
    process.env.COGPIT_EDITION = "team"
    const importTeam = teamPackage()
    await expect(loadEdition({ shell }, importTeam)).resolves.toBe("personal")
    expect(importTeam).not.toHaveBeenCalled()
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it("never asks for the package when nothing asks for team", async () => {
    const importTeam = teamPackage()
    await expect(loadEdition({ shell: "standalone" }, importTeam)).resolves.toBe("personal")
    expect(importTeam).not.toHaveBeenCalled()
  })

  it("is a no-op for the edition already running", async () => {
    const importTeam = teamPackage()
    await loadEdition({ shell: "standalone", configEdition: "team" }, importTeam)
    await loadEdition({ shell: "standalone", configEdition: "team" }, importTeam)
    expect(importTeam).toHaveBeenCalledOnce()
  })

  it("refuses to fall back to personal once team is running", async () => {
    await loadEdition({ shell: "standalone", configEdition: "team" }, teamPackage())
    await expect(loadEdition({ shell: "electron" }, teamPackage())).rejects.toThrow("already running its team edition")
    expect(getEdition()).toBe("team")
  })

  it.each([
    ["Bun", bunNotFound("@cogpit/team", LOADER)],
    ["Node", nodeNotFound("@cogpit/team", LOADER)],
  ])("refuses to boot a team edition the build does not include (%s)", async (_runtime, missing) => {
    const refusal = loadTeamFrom(async () => { throw missing })
    await expect(refusal).rejects.toThrow("Cogpit Team is not installed in this build")
    await expect(refusal).rejects.toThrow("set COGPIT_EDITION=personal or remove edition from config.local.json")
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it.each([
    ["Bun", bunNotFound("@cogpit/core/server/gone", INSTALLED_TEAM)],
    ["Node", nodeNotFound("@cogpit/core", INSTALLED_TEAM)],
    ["a plain error", new Error("boom in /app/node_modules/@cogpit/team/server/boot.ts")],
  ])("passes on a failure inside an installed team package unchanged (%s)", async (_runtime, inner) => {
    await expect(loadTeamFrom(async () => { throw inner })).rejects.toBe(inner)
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it("refuses a package whose default export is not a team edition", async () => {
    await expect(loadTeamFrom(async () => ({ default: PERSONAL_EDITION }))).rejects.toThrow("does not export a team edition")
    await expect(loadTeamFrom(async () => ({}))).rejects.toThrow("does not export a team edition")
    await expect(loadTeamFrom(async () => null)).rejects.toThrow("does not export a team edition")
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it("refuses a team edition built for another core, naming every member it lacks", async () => {
    const { flush: _flush, ...withoutFlush } = TEAM
    const outdated = {
      ...withoutFlush,
      me: "not a function",
      unguardedApiPaths: ["/api/setup", 1],
      access: { ...TEAM.access, markDecided: undefined },
      activity: null,
      notificationRetention: { hostEntries: 200, persistDelayMs: "soon" },
    }
    await expect(loadTeamFrom(async () => ({ default: outdated }))).rejects.toThrow(
      "@cogpit/team does not match this build of Cogpit; it lacks flush, me, unguardedApiPaths, access.markDecided, activity, notificationRetention.persistDelayMs",
    )
    expect(editionModule()).toBe(PERSONAL_EDITION)
  })

  it("requires an edition to state its authentication, even as null", async () => {
    const { auth: _auth, ...withoutAuth } = TEAM
    await expect(loadTeamFrom(async () => ({ default: withoutAuth }))).rejects.toThrow("it lacks auth")
    const partialAuth = { ...TEAM, auth: { middleware: () => {}, sessions: { flush: async () => {} } } }
    await expect(loadTeamFrom(async () => ({ default: partialAuth })))
      .rejects.toThrow("it lacks auth.login, auth.admitsSocket, auth.administers, auth.sessions.persist, auth.sessions.restore")
  })

  it("installs a team edition with its own authentication", async () => {
    const store = async () => {}
    const auth = {
      middleware: () => {},
      login: store,
      admitsSocket: () => true,
      administers: () => true,
      sessions: { persist: store, restore: () => null, touch: store, remove: store, removeForUser: store, clear: store, flush: store },
    }
    const withAuth: EditionModule = { ...TEAM, auth }
    await loadTeamFrom(async () => ({ default: withAuth }))
    expect(editionModule()).toBe(withAuth)
  })
})
