// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BrowserSessionInfo } from "../../../shared/browser/types"
import { accessAtLeast, SESSION_ACCESS_HEADER, type SessionAccessLevel } from "../../../shared/contracts/sessionAccess"
import { authorizeBrowser, browserControlFor, visibleBrowsers } from "../../browser/access"
import { DEFAULT_BROWSER, profileDir } from "../../browser/paths"
import { createBrowser } from "../../browser/registry"
import {
  __resetEditionForTest,
  PERSONAL_EDITION,
  sendSessionDenied,
  sendSessionHidden,
  type EditionBrowsers,
  type EditionSessionAccess,
  type VisibleSession,
} from "../../edition"
import { getRequestPrincipal, setRequestPrincipal } from "../../requestPrincipal"
import type { SessionPrincipal } from "../../sessionConstants"
import { createMockReqRes } from "../http-fixtures"
import { fakeEditionAuth } from "../edition/fakeAuth"
import { installFakeEdition } from "../edition/fakeEdition"

const SHARED_VIEW = "0f8fad5b-d9cb-469f-a165-70867728950e"
const SHARED_INTERACT = "1f8fad5b-d9cb-469f-a165-70867728950e"
const UNSEEN = "2f8fad5b-d9cb-469f-a165-70867728950e"
const ADMIN: SessionPrincipal = { userId: "u_admin", username: "ada", role: "admin" }
const BOB: SessionPrincipal = { userId: "u_bob", username: "bob", role: "member" }
/** What Bob holds on each session; any other is hidden from him. */
const BOBS_LEVELS: Record<string, SessionAccessLevel> = { [SHARED_VIEW]: "view", [SHARED_INTERACT]: "interact" }

/** An edition with accounts: each browses in `user-<id>`, and Bob holds BOBS_LEVELS. */
function installAccounts(): void {
  const levelOf = (req: IncomingMessage, sessionId: string): SessionAccessLevel | null =>
    principalOf(req)?.role === "admin" ? "own" : BOBS_LEVELS[sessionId] ?? null
  const check = (req: IncomingMessage) => async (sessionId: string): Promise<VisibleSession | "hidden"> => {
    const level = levelOf(req, sessionId)
    return level === null ? "hidden" : {
      annotate: async (item) => ({ ...item, access: { level, mine: false } }),
    }
  }
  const access: EditionSessionAccess = {
    ...PERSONAL_EDITION.access,
    visibilityFor: (req) => Object.assign(check(req), { everything: false, nothing: false }),
    authorizeSession: async (req, res, ref, needed) => {
      const sessionId = "sessionId" in ref ? ref.sessionId : ""
      const level = levelOf(req, sessionId)
      if (level === null) return sendSessionHidden(res, null)
      if (!accessAtLeast(level, needed)) return sendSessionDenied(res, level, sessionId)
      return { sessionId, filePath: null, isRootTranscript: true }
    },
  }
  const browsers: EditionBrowsers = {
    profileForSession: () => null,
    profileForCaller: (req) => {
      const principal = principalOf(req)
      return principal ? `user-${principal.userId}` : null
    },
    reservesName: (name) => name.startsWith("user-"),
    accountOf: (name) => (name === "user-u_alice" ? "Alice" : null),
  }
  installFakeEdition({ auth: fakeEditionAuth(), access, browsers })
}

const principalOf = getRequestPrincipal

function callAs(principal: SessionPrincipal | null) {
  const call = createMockReqRes("POST", "/api/browser")
  if (principal) setRequestPrincipal(call.req, principal)
  return call
}

function info(name: string, driverSessionId: string | null = null): BrowserSessionInfo {
  return {
    name,
    isDefault: name === DEFAULT_BROWSER,
    running: false,
    archived: true,
    note: null,
    createdAt: null,
    lastUsedAt: null,
    lastUrl: null,
    driverSessionId,
  }
}

function driveWith(name: string, sessionId: string): void {
  mkdirSync(profileDir(name), { recursive: true })
  writeFileSync(join(profileDir(name), ".driver"), `${sessionId}\n`)
}

const describe_ = async (name: string) => info(name)

let root = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-access-"))
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
})

afterEach(() => {
  __resetEditionForTest()
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

describe("visibleBrowsers", () => {
  const LISTED = [
    info(DEFAULT_BROWSER, SHARED_INTERACT),
    info("user-u_alice", SHARED_VIEW),
    info("shop", SHARED_INTERACT),
    info("secret", UNSEEN),
    info("mine-made"),
    info("stray"),
  ]

  it("lists everything as the caller's own in personal edition", async () => {
    const { req } = callAs(null)
    const shown = await visibleBrowsers(req, [info(DEFAULT_BROWSER), info("work", UNSEEN)], describe_)
    expect(shown.map(({ name, control, driverSessionId }) => ({ name, control, driverSessionId }))).toEqual([
      { name: DEFAULT_BROWSER, control: "own", driverSessionId: null },
      { name: "work", control: "own", driverSessionId: UNSEEN },
    ])
    expect(shown.some((session) => "mine" in session)).toBe(false)
  })

  it("shows an admin every browser, and their own before its first use", async () => {
    installAccounts()
    const { req } = callAs(ADMIN)
    const shown = await visibleBrowsers(req, LISTED, describe_)
    expect(shown.map(({ name, control }) => [name, control])).toEqual([
      ...LISTED.map(({ name }) => [name, "own"]),
      ["user-u_admin", "own"],
    ])
    expect(shown.find((session) => session.name === "user-u_admin")).toMatchObject({ mine: true, archived: false })
    expect(shown.find((session) => session.name === "user-u_alice")).toMatchObject({ account: "Alice" })
  })

  it("shows anyone else their own, what they made, and what sessions they can access drove", async () => {
    installAccounts()
    createBrowser("mine-made", undefined, BOB.userId)
    const { req } = callAs(BOB)
    const shown = await visibleBrowsers(req, LISTED, describe_)
    expect(shown.map(({ name, control, driverSessionId }) => ({ name, control, driverSessionId }))).toEqual([
      { name: "user-u_alice", control: "watch", driverSessionId: SHARED_VIEW },
      { name: "shop", control: "drive", driverSessionId: SHARED_INTERACT },
      { name: "mine-made", control: "own", driverSessionId: null },
      { name: "user-u_bob", control: "own", driverSessionId: null },
    ])
    expect(shown.find((session) => session.name === "user-u_bob")).toMatchObject({ mine: true, archived: false })
  })

  it("keeps the host's default from anyone else, whichever session drove it", async () => {
    installAccounts()
    const { req } = callAs(BOB)
    const shown = await visibleBrowsers(req, [info(DEFAULT_BROWSER, SHARED_INTERACT)], describe_)
    expect(shown.map(({ name }) => name)).toEqual(["user-u_bob"])
  })

  it("hides the session that drove a browser of theirs when they cannot see it", async () => {
    installAccounts()
    const { req } = callAs(BOB)
    const shown = await visibleBrowsers(req, [info("user-u_bob", UNSEEN)], describe_)
    expect(shown).toEqual([expect.objectContaining({ name: "user-u_bob", control: "own", driverSessionId: null })])
  })
})

describe("browserControlFor", () => {
  it("reads the driver from the browser's own profile", async () => {
    installAccounts()
    driveWith("shop", SHARED_INTERACT)
    driveWith("watched", SHARED_VIEW)
    driveWith("secret", UNSEEN)
    driveWith(DEFAULT_BROWSER, SHARED_INTERACT)
    const { req } = callAs(BOB)
    await expect(browserControlFor(req, "shop")).resolves.toBe("drive")
    await expect(browserControlFor(req, "watched")).resolves.toBe("watch")
    await expect(browserControlFor(req, "secret")).resolves.toBeNull()
    await expect(browserControlFor(req, DEFAULT_BROWSER)).resolves.toBeNull()
    await expect(browserControlFor(req, "never-used")).resolves.toBeNull()
    await expect(browserControlFor(req, "user-u_bob")).resolves.toBe("own")
    await expect(browserControlFor(callAs(ADMIN).req, DEFAULT_BROWSER)).resolves.toBe("own")
  })
})

describe("authorizeBrowser", () => {
  async function authorize(principal: SessionPrincipal, name: string, needed: "drive" | "own") {
    const call = callAs(principal)
    const allowed = await authorizeBrowser(call.req, call.res as ServerResponse, name, needed)
    const data = call.res._getData()
    return { allowed, status: call.res.statusCode, access: call.res._getHeaders()[SESSION_ACCESS_HEADER] ?? null, body: data ? JSON.parse(data) : null }
  }

  beforeEach(() => {
    installAccounts()
    driveWith("shop", SHARED_INTERACT)
    driveWith("watched", SHARED_VIEW)
    driveWith("secret", UNSEEN)
  })

  it("lets an owner drive and change their browsers without answering", async () => {
    createBrowser("made", undefined, BOB.userId)
    for (const name of ["made", "user-u_bob"]) {
      for (const needed of ["drive", "own"] as const) {
        expect(await authorize(BOB, name, needed)).toMatchObject({ allowed: true, body: null })
      }
    }
    expect(await authorize(ADMIN, "secret", "own")).toMatchObject({ allowed: true, body: null })
  })

  it("lets a session's interactor drive the browser it drove, and refuses a viewer at their level", async () => {
    expect(await authorize(BOB, "shop", "drive")).toMatchObject({ allowed: true, body: null })
    expect(await authorize(BOB, "watched", "drive")).toMatchObject({ allowed: false, status: 403, access: "view" })
  })

  it("answers a browser out of sight as a session out of sight", async () => {
    for (const name of ["secret", "never-used", DEFAULT_BROWSER]) {
      expect(await authorize(BOB, name, "drive")).toEqual({
        allowed: false,
        status: 404,
        access: "none",
        body: { error: "Session not found", code: "NOT_FOUND" },
      })
    }
  })

  it("keeps changing or deleting a browser to its owner, whatever the grant", async () => {
    for (const name of ["shop", "watched", "secret", "never-used"]) {
      expect(await authorize(BOB, name, "own")).toMatchObject({ allowed: false, status: 403, body: { code: "FORBIDDEN" } })
    }
  })
})
