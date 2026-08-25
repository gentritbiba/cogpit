import { readFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { hashPassword } from "../password-utils"
import { generatePassphrase } from "./passphrase"

/**
 * Per-session share registry.
 *
 * Persists one record per shared session to `shares.local.json` in the same
 * directory as `config.local.json` (userDataDir in Electron, project root in
 * dev). The file holds a scrypt hash of a passphrase that grants full
 * participation in one session, so it is written with mode 0600 and re-chmodded
 * after every write (writeFile's mode only applies at file *creation*).
 *
 * The plaintext passphrase exists only in the return value of `createShare` and
 * `rotateSharePassword`. It is never stored, never logged, and never returned
 * by a read.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ShareRecord {
  sessionId: string
  dirName: string
  fileName: string
  /** scrypt hash from password-utils; never serialized by listShares */
  passwordHash: string
  createdAt: number
  lastAccessAt: number
}

/** Share shape safe to serialize to the host UI: no hash, no passphrase. */
export type PublicShare = Omit<ShareRecord, "passwordHash">

export interface CreateShareInput {
  sessionId: string
  dirName: string
  fileName: string
}

/** A share plus the one and only copy of the passphrase that unlocks it. */
export interface IssuedShare {
  share: PublicShare
  passphrase: string
}

// ── Module state ─────────────────────────────────────────────────────

let registryPath: string | null = null
const shares = new Map<string, ShareRecord>()
let registryOperationQueue: Promise<void> = Promise.resolve()

// ── Persistence ──────────────────────────────────────────────────────

function normalizeShare(entry: unknown): ShareRecord | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as Record<string, unknown>
  if (
    typeof e.sessionId !== "string"
    || typeof e.dirName !== "string"
    || typeof e.fileName !== "string"
    || typeof e.passwordHash !== "string"
  ) return null
  return {
    sessionId: e.sessionId,
    dirName: e.dirName,
    fileName: e.fileName,
    passwordHash: e.passwordHash,
    createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    lastAccessAt: typeof e.lastAccessAt === "number" ? e.lastAccessAt : 0,
  }
}

function enqueueRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryOperationQueue.then(operation)
  // A rejected persistence attempt belongs to its caller. Keep a handled tail
  // so later operations still run rather than inheriting the rejection.
  registryOperationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function replaceShares(nextShares: ReadonlyMap<string, ShareRecord>): void {
  shares.clear()
  for (const [sessionId, share] of nextShares) shares.set(sessionId, share)
}

async function persist(
  filePath: string | null,
  snapshot: readonly ShareRecord[],
): Promise<void> {
  if (!filePath) return
  await writeOwnerOnlyJson(filePath, snapshot)
}

interface ShareMutation<T> {
  changed: boolean
  value: T
}

function commitShareMutation<T>(
  mutate: (draft: Map<string, ShareRecord>) => ShareMutation<T>,
): Promise<T> {
  return enqueueRegistryOperation(async () => {
    // Clone records as well as the map so an existing share reference cannot
    // change the candidate while its atomic write is in flight.
    const draft = new Map(
      [...shares].map(([sessionId, share]) => [sessionId, { ...share }]),
    )
    const mutation = mutate(draft)
    if (!mutation.changed) return mutation.value

    // The durable snapshot is created inside the serialized queue turn. Live
    // state changes only after persistence succeeds, so rejection implicitly
    // rolls the mutation back by discarding this draft.
    const snapshot = [...draft.values()].map((share) => ({ ...share }))
    await persist(registryPath, snapshot)
    replaceShares(draft)
    return mutation.value
  })
}

/**
 * Point the registry at `<dir>/shares.local.json` and load it. A missing or
 * corrupt file yields an empty registry rather than throwing.
 */
export async function initShareRegistry(dir: string): Promise<void> {
  await enqueueRegistryOperation(async () => {
    const nextRegistryPath = join(dir, "shares.local.json")
    const loadedShares = new Map<string, ShareRecord>()

    let raw: string | null = null
    try {
      const contents = await readFile(nextRegistryPath, "utf-8")
      // Existing installations may predate owner-only creation. Refuse to load
      // password hashes unless the registry can be repaired to owner-only mode.
      await chmod(nextRegistryPath, 0o600)
      raw = contents
    } catch {
      // Missing file (first run) or unreadable → start empty.
    }

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const share = normalizeShare(entry)
            if (share) loadedShares.set(share.sessionId, share)
          }
        }
      } catch {
        // Corrupt JSON → start empty rather than crashing the shell.
      }
    }

    registryPath = nextRegistryPath
    replaceShares(loadedShares)
  })
}

// ── Reads ────────────────────────────────────────────────────────────

function toPublicShare(share: ShareRecord): PublicShare {
  // Explicitly destructure the hash out so it can never leak.
  const { passwordHash: _passwordHash, ...safe } = share
  void _passwordHash
  return safe
}

/** Full share record including the hash — for internal (server-side) use only. */
export function getShare(sessionId: string): ShareRecord | undefined {
  return shares.get(sessionId)
}

/**
 * All shares in insertion (registry) order.
 * NEVER includes the `passwordHash` field.
 */
export function listShares(): PublicShare[] {
  return [...shares.values()].map(toPublicShare)
}

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Share a session, replacing any existing share for it. The previous
 * passphrase stops working the moment this resolves.
 */
export async function createShare(input: CreateShareInput): Promise<IssuedShare> {
  const passphrase = generatePassphrase()
  const passwordHash = hashPassword(passphrase)
  const share = await commitShareMutation((draft) => {
    const now = Date.now()
    const record: ShareRecord = {
      sessionId: input.sessionId,
      dirName: input.dirName,
      fileName: input.fileName,
      passwordHash,
      createdAt: now,
      lastAccessAt: now,
    }
    draft.set(record.sessionId, record)
    return { changed: true, value: toPublicShare(record) }
  })
  return { share, passphrase }
}

/** Issue a new passphrase for an existing share; null when it is not shared. */
export async function rotateSharePassword(sessionId: string): Promise<IssuedShare | null> {
  const passphrase = generatePassphrase()
  const passwordHash = hashPassword(passphrase)
  const share = await commitShareMutation<PublicShare | null>((draft) => {
    const existing = draft.get(sessionId)
    if (!existing) return { changed: false, value: null }

    const next: ShareRecord = { ...existing, passwordHash }
    draft.set(sessionId, next)
    return { changed: true, value: toPublicShare(next) }
  })
  return share ? { share, passphrase } : null
}

export async function removeShare(sessionId: string): Promise<boolean> {
  return commitShareMutation((draft) => {
    if (!draft.delete(sessionId)) return { changed: false, value: false }
    return { changed: true, value: true }
  })
}

/**
 * Record guest activity. In memory only: persisting here would rewrite the
 * registry file on every guest request.
 */
export function touchShare(sessionId: string): void {
  const share = shares.get(sessionId)
  if (share) share.lastAccessAt = Date.now()
}
