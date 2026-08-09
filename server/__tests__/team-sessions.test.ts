// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { IncomingMessage } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionToken,
  validateSessionToken,
  getSessionPrincipal,
  revokeSessionToken,
  revokeAllSessions,
  revokeSessionsForUser,
  SESSION_ABSOLUTE_TTL_MS,
  __resetSessionsForTest,
  type SessionPrincipal,
} from "../security"
import { initEdition, __resetEditionForTest } from "../team/edition"
import {
  initUsersStore,
  createUser,
  setUserDisabled,
  setUserRole,
  __resetUsersForTest,
} from "../team/users"
import {
  initSessionPersistence,
  __flushForTest,
  __resetForTest,
} from "../team/sessionPersistence"
import { setRequestPrincipal, getRequestPrincipal } from "../team/requestPrincipal"

// Windows has no POSIX modes — chmod only toggles the read-only bit there.
const POSIX_MODES_UNSUPPORTED = process.platform === "win32"

const STRONG_PASSWORD = "correct-horse-battery-staple"
const UA = "Browser/1"

const originalEditionEnv = process.env.COGPIT_EDITION

let root: string
let teamDir: string

function enterTeamEdition(): void {
  initEdition({ shell: "standalone", configEdition: "team" })
}

async function initTeamStores(): Promise<void> {
  await initUsersStore(teamDir)
  await initSessionPersistence(teamDir)
}

async function createPrincipal(
  username: string,
  role: "admin" | "member",
): Promise<SessionPrincipal> {
  const user = await createUser({ username, password: STRONG_PASSWORD, role })
  return { userId: user.id, username: user.username, role: user.role }
}

/** Wait for fire-and-forget persistence writes, then wipe only the in-memory map. */
async function simulateRestart(): Promise<void> {
  await __flushForTest()
  __resetSessionsForTest()
}

beforeEach(async () => {
  delete process.env.COGPIT_EDITION
  root = await mkdtemp(join(tmpdir(), "cogpit-team-sessions-"))
  teamDir = join(root, "team")
})

afterEach(async () => {
  vi.useRealTimers()
  __resetSessionsForTest()
  __resetForTest()
  __resetUsersForTest()
  __resetEditionForTest()
  if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEditionEnv
  await rm(root, { recursive: true, force: true })
})

// ── Principal-carrying sessions ─────────────────────────────────────────

describe("createSessionToken with a principal", () => {
  it("attaches the principal and getSessionPrincipal returns it", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")

    const token = createSessionToken("127.0.0.1", UA, principal)
    expect(validateSessionToken(token, UA)).toBe(true)
    expect(getSessionPrincipal(token)).toEqual(principal)
  })

  it("returns null for a session created without a principal", () => {
    const token = createSessionToken("127.0.0.1")
    expect(getSessionPrincipal(token)).toBeNull()
  })

  it("returns null for an unknown token", () => {
    expect(getSessionPrincipal("nonexistent")).toBeNull()
  })

  it("carries the principal in personal edition without persisting anything", async () => {
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")

    const token = createSessionToken("127.0.0.1", UA, principal)
    expect(getSessionPrincipal(token)).toEqual(principal)

    await __flushForTest()
    expect(await readdir(teamDir)).not.toContain("sessions.json")
  })
})

// ── Restart survival ────────────────────────────────────────────────────

describe("restart survival (team edition)", () => {
  it("restores a persisted session after the in-memory map is cleared", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken("127.0.0.1", UA, principal)

    await simulateRestart()
    expect(getSessionPrincipal(token)).toBeNull()

    expect(validateSessionToken(token, UA)).toBe(true)
    expect(getSessionPrincipal(token)).toEqual(principal)
  })

  it("does not restore sessions created without a principal", async () => {
    enterTeamEdition()
    await initTeamStores()

    const token = createSessionToken("127.0.0.1", UA)
    expect(validateSessionToken(token, UA)).toBe(true)

    await simulateRestart()
    expect(validateSessionToken(token, UA)).toBe(false)
  })

  it("re-reads the current role at rehydrate time", async () => {
    enterTeamEdition()
    await initTeamStores()
    await createPrincipal("alice", "admin")
    const bob = await createPrincipal("bob", "member")
    const token = createSessionToken("127.0.0.1", UA, bob)

    await setUserRole(bob.userId, "admin")
    await simulateRestart()

    expect(validateSessionToken(token, UA)).toBe(true)
    expect(getSessionPrincipal(token)?.role).toBe("admin")
  })

  it("does not restore a disabled user's session", async () => {
    enterTeamEdition()
    await initTeamStores()
    await createPrincipal("alice", "admin")
    const bob = await createPrincipal("bob", "member")
    const token = createSessionToken("127.0.0.1", UA, bob)

    await setUserDisabled(bob.userId, true)
    await simulateRestart()

    expect(validateSessionToken(token, UA)).toBe(false)
  })

  it("does not restore a session past the absolute TTL", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")

    vi.useFakeTimers()
    const token = createSessionToken("127.0.0.1", UA, principal)
    await simulateRestart()

    vi.advanceTimersByTime(SESSION_ABSOLUTE_TTL_MS + 1)
    expect(validateSessionToken(token, UA)).toBe(false)
  })

  it("keeps the original createdAt so the absolute TTL spans restarts", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")

    vi.useFakeTimers()
    const token = createSessionToken("127.0.0.1", UA, principal)
    await simulateRestart()

    vi.advanceTimersByTime(SESSION_ABSOLUTE_TTL_MS - 1)
    expect(validateSessionToken(token, UA)).toBe(true)

    vi.advanceTimersByTime(2)
    expect(validateSessionToken(token, UA)).toBe(false)
  })
})

// ── Revocation ──────────────────────────────────────────────────────────

describe("revocation (team edition)", () => {
  it("revokeSessionToken removes the persisted row too", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken("127.0.0.1", UA, principal)
    await __flushForTest()

    revokeSessionToken(token)
    await simulateRestart()

    expect(validateSessionToken(token, UA)).toBe(false)
  })

  it("revokeAllSessions clears persistence too", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken("127.0.0.1", UA, principal)
    await __flushForTest()

    revokeAllSessions()
    await simulateRestart()

    expect(validateSessionToken(token, UA)).toBe(false)
  })

  it("revokeSessionsForUser revokes only that user's sessions, in memory and on disk", async () => {
    enterTeamEdition()
    await initTeamStores()
    const alice = await createPrincipal("alice", "admin")
    const bob = await createPrincipal("bob", "member")
    const aliceToken = createSessionToken("127.0.0.1", UA, alice)
    const bobToken = createSessionToken("127.0.0.1", UA, bob)
    await __flushForTest()

    revokeSessionsForUser(bob.userId)
    expect(validateSessionToken(bobToken, UA)).toBe(false)
    expect(validateSessionToken(aliceToken, UA)).toBe(true)

    await simulateRestart()
    expect(validateSessionToken(bobToken, UA)).toBe(false)
    expect(validateSessionToken(aliceToken, UA)).toBe(true)
  })
})

// ── On-disk format ──────────────────────────────────────────────────────

describe("on-disk format (team edition)", () => {
  it("stores sha256 token hashes, never raw tokens", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")
    const token = createSessionToken("127.0.0.1", UA, principal)
    await __flushForTest()

    const raw = await readFile(join(teamDir, "sessions.json"), "utf-8")
    expect(raw).not.toContain(token)

    const parsed = JSON.parse(raw)
    expect(parsed.sessions).toHaveLength(1)
    const row = parsed.sessions[0]
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(row.userId).toBe(principal.userId)
    expect(row.expiresAt).toBe(row.createdAt + SESSION_ABSOLUTE_TTL_MS)
  })

  it.skipIf(POSIX_MODES_UNSUPPORTED)("keeps sessions.json 0600", async () => {
    enterTeamEdition()
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")
    createSessionToken("127.0.0.1", UA, principal)
    await __flushForTest()

    expect((await stat(join(teamDir, "sessions.json"))).mode & 0o777).toBe(0o600)
  })
})

// ── Personal edition ────────────────────────────────────────────────────

describe("personal edition", () => {
  it("never writes team/sessions.json and never restores", async () => {
    await initTeamStores()
    const principal = await createPrincipal("alice", "admin")

    const token = createSessionToken("127.0.0.1", UA, principal)
    expect(validateSessionToken(token, UA)).toBe(true)

    await simulateRestart()
    expect(validateSessionToken(token, UA)).toBe(false)
    expect(await readdir(teamDir)).not.toContain("sessions.json")
  })
})

// ── Request principal handoff ───────────────────────────────────────────

describe("requestPrincipal", () => {
  it("stores and returns a principal per request object", () => {
    const req = {} as IncomingMessage
    const principal: SessionPrincipal = { userId: "u_1", username: "alice", role: "admin" }

    setRequestPrincipal(req, principal)
    expect(getRequestPrincipal(req)).toEqual(principal)
  })

  it("returns null for a request it has never seen", () => {
    expect(getRequestPrincipal({} as IncomingMessage)).toBeNull()
  })
})
