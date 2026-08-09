import { chmod, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { hashPassword, validatePasswordStrength } from "../password-utils"
import type { TeamRole, TeamUserPublic } from "../../shared/contracts/team"

/**
 * Team-edition user accounts store.
 *
 * Persists `{ users: TeamUser[] }` to `<dataRoot>/team/users.json` with
 * owner-only modes (0700 directory, 0600 file — the file holds password
 * hashes). Mutations serialize through a single promise chain and only swap
 * the in-memory state after the atomic write succeeds, so a failed persist
 * rolls the mutation back.
 */

export interface TeamUser extends TeamUserPublic {
  passwordHash: string
}

/** Validation failure the routes map to HTTP 400. */
export class UserValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserValidationError"
  }
}

export interface CreateUserInput {
  username: string
  displayName?: string
  password: string
  role: TeamRole
}

// Also excludes ":" — usernames travel as `user:pass` Bearer credentials.
const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/

// ── Module state ─────────────────────────────────────────────────────

let usersPath: string | null = null
const users = new Map<string, TeamUser>()
let usersOperationQueue: Promise<void> = Promise.resolve()

export function __resetUsersForTest(): void {
  usersPath = null
  users.clear()
  usersOperationQueue = Promise.resolve()
}

// ── Persistence ──────────────────────────────────────────────────────

function enqueueUsersOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = usersOperationQueue.then(operation)
  // A rejected operation belongs to its caller. Keep a handled tail so later
  // operations still run rather than inheriting the rejection.
  usersOperationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function replaceUsers(nextUsers: ReadonlyMap<string, TeamUser>): void {
  users.clear()
  for (const [id, user] of nextUsers) users.set(id, user)
}

async function persist(filePath: string | null, snapshot: readonly TeamUser[]): Promise<void> {
  if (!filePath) return
  await writeOwnerOnlyJson(filePath, { users: snapshot }, 0o600)
}

interface UserMutation<T> {
  changed: boolean
  value: T
}

function commitUserMutation<T>(
  mutate: (draft: Map<string, TeamUser>) => UserMutation<T>,
): Promise<T> {
  return enqueueUsersOperation(async () => {
    // Clone records as well as the map so an existing user reference cannot
    // change the candidate while its atomic write is in flight.
    const draft = new Map(
      [...users].map(([id, user]) => [id, { ...user }]),
    )
    const mutation = mutate(draft)
    if (!mutation.changed) return mutation.value

    const snapshot = [...draft.values()].map((user) => ({ ...user }))
    await persist(usersPath, snapshot)
    replaceUsers(draft)
    return mutation.value
  })
}

/**
 * Point the store at `<dir>/users.json` and load it. A missing file yields an
 * empty store (first run — bootstrap open); an unreadable or corrupt file
 * fails closed instead, because an empty store would silently reopen the
 * unauthenticated first-admin bootstrap.
 */
export async function initUsersStore(dir: string): Promise<void> {
  await enqueueUsersOperation(async () => {
    await mkdir(dir, { recursive: true })
    // Windows has no POSIX modes: chmod only toggles the read-only bit there.
    if (process.platform !== "win32") {
      await chmod(dir, 0o700)
    }

    const nextPath = join(dir, "users.json")
    let raw: string | null = null
    try {
      raw = await readFile(nextPath, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const loaded = new Map<string, TeamUser>()
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.users)) {
        throw new Error("Malformed team users store")
      }
      for (const user of parsed.users as TeamUser[]) loaded.set(user.id, user)
    }

    usersPath = nextPath
    replaceUsers(loaded)
  })
}

// ── Reads ────────────────────────────────────────────────────────────

export function userCount(): number {
  return users.size
}

/** Users safe to serialize to API clients: NEVER includes `passwordHash`. */
export function listUsers(): TeamUserPublic[] {
  return [...users.values()].map((user) => {
    // Explicitly destructure the hash out so it can never leak.
    const { passwordHash: _passwordHash, ...safe } = user
    void _passwordHash
    return safe
  })
}

/** Full record including the hash — for internal (server-side) use only. */
export function getUserByUsername(username: string): TeamUser | null {
  const normalized = username.trim().toLowerCase()
  for (const user of users.values()) {
    if (user.username === normalized) return user
  }
  return null
}

/** Full record including the hash — for internal (server-side) use only. */
export function getUserById(id: string): TeamUser | null {
  return users.get(id) ?? null
}

// ── Mutations ────────────────────────────────────────────────────────

function requireUser(draft: Map<string, TeamUser>, id: string): TeamUser {
  const user = draft.get(id)
  if (!user) throw new UserValidationError("User not found")
  return user
}

function isLastEnabledAdmin(draft: Map<string, TeamUser>, id: string): boolean {
  const user = draft.get(id)
  if (!user || user.role !== "admin" || user.disabled) return false
  for (const other of draft.values()) {
    if (other.id !== id && other.role === "admin" && !other.disabled) return false
  }
  return true
}

export async function createUser(input: CreateUserInput): Promise<TeamUserPublic> {
  const username = input.username.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserValidationError(
      "Username must be 2-32 characters using a-z, 0-9, dots, underscores, or hyphens",
    )
  }
  if (input.role !== "admin" && input.role !== "member") {
    throw new UserValidationError("Role must be admin or member")
  }
  const strengthError = validatePasswordStrength(input.password)
  if (strengthError) throw new UserValidationError(strengthError)
  const passwordHash = hashPassword(input.password)

  return commitUserMutation((draft) => {
    for (const existing of draft.values()) {
      if (existing.username === username) {
        throw new UserValidationError("Username is already taken")
      }
    }
    const user: TeamUser = {
      id: `u_${randomBytes(6).toString("hex")}`,
      username,
      displayName: input.displayName?.trim() || username,
      role: input.role,
      createdAt: Date.now(),
      passwordHash,
    }
    draft.set(user.id, user)
    const { passwordHash: _passwordHash, ...publicUser } = user
    void _passwordHash
    return { changed: true, value: publicUser }
  })
}

export async function setUserDisabled(id: string, disabled: boolean): Promise<void> {
  await commitUserMutation((draft) => {
    const user = requireUser(draft, id)
    if (disabled && isLastEnabledAdmin(draft, id)) {
      throw new UserValidationError("Cannot remove the last admin")
    }
    draft.set(id, { ...user, disabled: disabled || undefined })
    return { changed: true, value: undefined }
  })
}

export async function setUserPassword(id: string, password: string): Promise<void> {
  const strengthError = validatePasswordStrength(password)
  if (strengthError) throw new UserValidationError(strengthError)
  const passwordHash = hashPassword(password)

  await commitUserMutation((draft) => {
    const user = requireUser(draft, id)
    draft.set(id, { ...user, passwordHash })
    return { changed: true, value: undefined }
  })
}

export async function setUserRole(id: string, role: TeamRole): Promise<void> {
  if (role !== "admin" && role !== "member") {
    throw new UserValidationError("Role must be admin or member")
  }
  await commitUserMutation((draft) => {
    const user = requireUser(draft, id)
    if (role === "member" && isLastEnabledAdmin(draft, id)) {
      throw new UserValidationError("Cannot remove the last admin")
    }
    draft.set(id, { ...user, role })
    return { changed: true, value: undefined }
  })
}
