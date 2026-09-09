import { chmod, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { replaceAll, serialQueue } from "../lib/serialQueue"
import { hashPassword, isPasswordHashed, validatePasswordStrength } from "../password-utils"
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
const MAX_DISPLAY_NAME_LENGTH = 64

// ── Module state ─────────────────────────────────────────────────────

let usersPath: string | null = null
const users = new Map<string, TeamUser>()
const queue = serialQueue()

export function __resetUsersForTest(): void {
  usersPath = null
  users.clear()
  queue.reset()
}

// ── Persistence ──────────────────────────────────────────────────────

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
  return queue.run(async () => {
    // Never mutate memory-only: without a store path the change could not
    // persist and would silently vanish on restart.
    if (!usersPath) throw new Error("Users store is not initialized")
    // Clone records as well as the map so an existing user reference cannot
    // change the candidate while its atomic write is in flight.
    const draft = new Map(
      [...users].map(([id, user]) => [id, { ...user }]),
    )
    const mutation = mutate(draft)
    if (!mutation.changed) return mutation.value

    const snapshot = [...draft.values()].map((user) => ({ ...user }))
    await persist(usersPath, snapshot)
    replaceAll(users, draft)
    return mutation.value
  })
}

/**
 * A record whose identity fields or password hash cannot be trusted must fail
 * the whole load, exactly like an unparseable file: dropping it would shrink
 * the store and could reopen the unauthenticated first-admin bootstrap, and an
 * unhashed passwordHash would let a tampered file plant plaintext credentials.
 */
function isValidStoredUser(user: unknown): user is TeamUser {
  if (typeof user !== "object" || user === null) return false
  const candidate = user as Partial<TeamUser>
  return (
    typeof candidate.id === "string" && candidate.id.length > 0
    && typeof candidate.username === "string" && candidate.username.length > 0
    && typeof candidate.passwordHash === "string"
    && isPasswordHashed(candidate.passwordHash)
  )
}

/**
 * Point the store at `<dir>/users.json` and load it. A missing file yields an
 * empty store (first run — bootstrap open); an unreadable or corrupt file
 * fails closed instead, because an empty store would silently reopen the
 * unauthenticated first-admin bootstrap.
 */
export async function initUsersStore(dir: string): Promise<void> {
  await queue.run(async () => {
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
      for (const user of parsed.users) {
        if (!isValidStoredUser(user)) throw new Error("Malformed team users store")
        loaded.set(user.id, user)
      }
    }

    usersPath = nextPath
    replaceAll(users, loaded)
  })
}

// ── Reads ────────────────────────────────────────────────────────────

export function userCount(): number {
  return users.size
}

/**
 * False until initUsersStore has succeeded. Callers gating on "no users yet"
 * (the bootstrap carve-out) must also check this: before init, userCount() is
 * trivially 0 even when users exist on disk.
 */
export function isUsersStoreInitialized(): boolean {
  return usersPath !== null
}

/**
 * Allow-list projection to exactly the TeamUserPublic fields. Unlike a
 * block-list destructure, a secret added to the record later — or an unknown
 * key smuggled in via the loaded file — can never reach an API response.
 */
export function toPublicUser(user: TeamUser): TeamUserPublic {
  const publicUser: TeamUserPublic = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  }
  if (user.disabled) publicUser.disabled = true
  return publicUser
}

/** Users safe to serialize to API clients: NEVER includes `passwordHash`. */
export function listUsers(): TeamUserPublic[] {
  return [...users.values()].map(toPublicUser)
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

export type VerifiedUserOperationResult<T> =
  | { status: "current"; value: T }
  | { status: "invalid" }
  | { status: "disabled" }

/**
 * Linearize session issuance with user mutations after an asynchronous password
 * check. Mutations that committed during verification are observed here; once
 * the callback starts, later mutations wait and will revoke the issued session
 * after they commit.
 */
export function withVerifiedUser<T>(
  id: string,
  verifiedPasswordHash: string,
  operation: (user: TeamUser) => Promise<T>,
): Promise<VerifiedUserOperationResult<T>> {
  return queue.run(async () => {
    const current = users.get(id)
    if (!current || current.passwordHash !== verifiedPasswordHash) {
      return { status: "invalid" }
    }
    if (current.disabled) return { status: "disabled" }
    return { status: "current", value: await operation({ ...current }) }
  })
}

// ── Mutations ────────────────────────────────────────────────────────

function requireUser(draft: Map<string, TeamUser>, id: string): TeamUser {
  const user = draft.get(id)
  if (!user) throw new UserValidationError("User not found")
  return user
}

/**
 * The last-admin rule, in one place: no change to an admin account may leave
 * the store without an enabled admin. Evaluated against the *result* of the
 * change, so a patch that both re-enables and demotes the only admin is caught
 * as one step instead of passing its halves.
 *
 * Only admin accounts can trip it — changing a member never removes an admin,
 * and a store that somehow holds none must stay manageable.
 */
function findLastAdminViolation(
  users: ReadonlyMap<string, TeamUser>,
  id: string,
  next: TeamUser,
): string | null {
  if (users.get(id)?.role !== "admin" && next.role !== "admin") return null
  for (const user of users.values()) {
    const after = user.id === id ? next : user
    if (after.role === "admin" && !after.disabled) return null
  }
  return "Cannot remove the last admin"
}

/** The fields a single request may change together. */
export interface UserChanges {
  disabled?: boolean
  role?: TeamRole
}

/**
 * The error a change set would raise, or null. Callers applying several fields
 * must check this first: the mutations below persist one field at a time, so a
 * rule tripped by a later field would otherwise leave the earlier ones written.
 */
export function validateUserChanges(id: string, changes: UserChanges): string | null {
  const user = users.get(id)
  if (!user) return "User not found"
  return findLastAdminViolation(users, id, {
    ...user,
    role: changes.role ?? user.role,
    disabled: (changes.disabled ?? user.disabled) || undefined,
  })
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
  let displayName = username
  if (input.displayName !== undefined) {
    displayName = input.displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
    if (!displayName) throw new UserValidationError("Display name cannot be empty")
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
      displayName,
      role: input.role,
      createdAt: Date.now(),
      passwordHash,
    }
    draft.set(user.id, user)
    return { changed: true, value: toPublicUser(user) }
  })
}

export async function setUserDisabled(id: string, disabled: boolean): Promise<void> {
  await commitUserMutation((draft) => {
    const user = requireUser(draft, id)
    const next = { ...user, disabled: disabled || undefined }
    const violation = findLastAdminViolation(draft, id, next)
    if (violation) throw new UserValidationError(violation)
    draft.set(id, next)
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
    const next = { ...user, role }
    const violation = findLastAdminViolation(draft, id, next)
    if (violation) throw new UserValidationError(violation)
    draft.set(id, next)
    return { changed: true, value: undefined }
  })
}
