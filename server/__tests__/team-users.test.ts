// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { verifyPassword } from "../security"
import {
  initUsersStore,
  createUser,
  listUsers,
  userCount,
  getUserByUsername,
  getUserById,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  UserValidationError,
  __resetUsersForTest,
} from "../team/users"

// Windows has no POSIX modes — chmod only toggles the read-only bit there, so
// a real file can never report 0600.
const POSIX_MODES_UNSUPPORTED = process.platform === "win32"

const STRONG_PASSWORD = "correct-horse-battery-staple"
const OTHER_PASSWORD = "another-long-passphrase"

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-team-users-"))
  dir = join(root, "team")
  await initUsersStore(dir)
})

afterEach(async () => {
  __resetUsersForTest()
  await rm(root, { recursive: true, force: true })
})

// ── createUser / listUsers ──────────────────────────────────────────────

describe("createUser", () => {
  it("creates a user and lists it without the password hash", async () => {
    const created = await createUser({ username: " Alice ", password: STRONG_PASSWORD, role: "admin" })

    expect(created.id).toMatch(/^u_[0-9a-f]{12}$/)
    expect(created.username).toBe("alice")
    expect(created.displayName).toBe("alice")
    expect(created.role).toBe("admin")
    expect(created.createdAt).toBeGreaterThan(0)
    expect("passwordHash" in created).toBe(false)

    const list = listUsers()
    expect(list).toHaveLength(1)
    expect(list[0].username).toBe("alice")
    expect(JSON.stringify(list)).not.toContain("passwordHash")
    expect(userCount()).toBe(1)
  })

  it("returns the full record, hash included, via the internal getters", async () => {
    const created = await createUser({
      username: "alice",
      displayName: "Alice Doe",
      password: STRONG_PASSWORD,
      role: "member",
    })

    const byName = getUserByUsername(" ALICE ")
    expect(byName?.id).toBe(created.id)
    expect(byName?.displayName).toBe("Alice Doe")
    expect(verifyPassword(STRONG_PASSWORD, byName!.passwordHash)).toBe(true)

    expect(getUserById(created.id)?.username).toBe("alice")
    expect(getUserById("u_missing")).toBeNull()
    expect(getUserByUsername("bob")).toBeNull()
  })

  it("rejects a duplicate username case-insensitively", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })

    await expect(createUser({ username: " ALICE ", password: OTHER_PASSWORD, role: "member" }))
      .rejects.toThrow(UserValidationError)
    expect(userCount()).toBe(1)
  })

  it("rejects invalid usernames", async () => {
    for (const bad of ["a", "x".repeat(33), "has space", "naïve", "semi;colon", ""]) {
      await expect(createUser({ username: bad, password: STRONG_PASSWORD, role: "member" }))
        .rejects.toThrow(UserValidationError)
    }
    expect(userCount()).toBe(0)
  })

  it("rejects a colon in the username (Bearer credential separator)", async () => {
    await expect(createUser({ username: "alice:admin", password: STRONG_PASSWORD, role: "member" }))
      .rejects.toThrow(UserValidationError)
  })

  it("rejects a weak password without creating the user", async () => {
    await expect(createUser({ username: "alice", password: "short", role: "admin" }))
      .rejects.toThrow(UserValidationError)
    expect(userCount()).toBe(0)
  })

  it("allows only one of two concurrent creates with the same username", async () => {
    const results = await Promise.allSettled([
      createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" }),
      createUser({ username: "alice", password: OTHER_PASSWORD, role: "member" }),
    ])

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(userCount()).toBe(1)
  })
})

// ── last-admin protection ───────────────────────────────────────────────

describe("last-admin protection", () => {
  it("refuses to disable the last enabled admin", async () => {
    const admin = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })

    await expect(setUserDisabled(admin.id, true)).rejects.toThrow("Cannot remove the last admin")
    expect(getUserById(admin.id)?.disabled).toBeUndefined()
  })

  it("refuses to demote the last enabled admin", async () => {
    const admin = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })

    await expect(setUserRole(admin.id, "member")).rejects.toThrow("Cannot remove the last admin")
    expect(getUserById(admin.id)?.role).toBe("admin")
  })

  it("does not count a disabled admin as cover", async () => {
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "admin" })

    await setUserDisabled(bob.id, true)

    await expect(setUserDisabled(alice.id, true)).rejects.toThrow("Cannot remove the last admin")
  })

  it("allows disabling an admin while another enabled admin remains", async () => {
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    await createUser({ username: "bob", password: STRONG_PASSWORD, role: "admin" })

    await setUserDisabled(alice.id, true)
    expect(getUserById(alice.id)?.disabled).toBe(true)

    await setUserDisabled(alice.id, false)
    expect(getUserById(alice.id)?.disabled).toBeUndefined()
  })
})

// ── other mutations ─────────────────────────────────────────────────────

describe("mutations", () => {
  it("strength-checks and re-hashes on password change", async () => {
    const created = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const before = getUserById(created.id)!.passwordHash

    await expect(setUserPassword(created.id, "weak")).rejects.toThrow(UserValidationError)
    expect(getUserById(created.id)!.passwordHash).toBe(before)

    await setUserPassword(created.id, OTHER_PASSWORD)
    const after = getUserById(created.id)!.passwordHash
    expect(after).not.toBe(before)
    expect(verifyPassword(OTHER_PASSWORD, after)).toBe(true)
  })

  it("rejects mutations for an unknown user id", async () => {
    await expect(setUserDisabled("u_missing", true)).rejects.toThrow(UserValidationError)
    await expect(setUserRole("u_missing", "admin")).rejects.toThrow(UserValidationError)
    await expect(setUserPassword("u_missing", STRONG_PASSWORD)).rejects.toThrow(UserValidationError)
  })
})

// ── persistence ─────────────────────────────────────────────────────────

describe("persistence", () => {
  it("round-trips users through a store re-init", async () => {
    const created = await createUser({
      username: "alice",
      displayName: "Alice Doe",
      password: STRONG_PASSWORD,
      role: "admin",
    })

    __resetUsersForTest()
    expect(userCount()).toBe(0)

    await initUsersStore(dir)
    expect(userCount()).toBe(1)
    const restored = getUserById(created.id)
    expect(restored?.username).toBe("alice")
    expect(restored?.displayName).toBe("Alice Doe")
    expect(restored?.role).toBe("admin")
    expect(verifyPassword(STRONG_PASSWORD, restored!.passwordHash)).toBe(true)
  })

  it("persists concurrent mutations serially without losing any", async () => {
    await Promise.all([
      createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" }),
      createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" }),
      createUser({ username: "carol", password: STRONG_PASSWORD, role: "member" }),
    ])
    expect(userCount()).toBe(3)

    __resetUsersForTest()
    await initUsersStore(dir)
    expect(userCount()).toBe(3)
  })

  it("stores the expected on-disk shape", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })

    const onDisk = JSON.parse(await readFile(join(dir, "users.json"), "utf-8"))
    expect(Array.isArray(onDisk.users)).toBe(true)
    expect(onDisk.users[0].username).toBe("alice")
  })

  it.skipIf(POSIX_MODES_UNSUPPORTED)("keeps the users file 0600 inside a 0700 directory", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })

    expect((await stat(join(dir, "users.json"))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it("fails closed on a corrupt users file instead of reopening bootstrap", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    await writeFile(join(dir, "users.json"), "not-json{{{", "utf-8")
    __resetUsersForTest()

    await expect(initUsersStore(dir)).rejects.toThrow()
  })
})
