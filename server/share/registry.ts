import { join } from "node:path"
import { readOwnerOnlyJsonArray, writeOwnerOnlyJson } from "../atomicJsonFile"
import { replaceAll, serialQueue } from "../lib/serialQueue"
import { hashPassword, isPasswordHashed } from "../password-utils"
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
export interface PublicShare {
  sessionId: string
  dirName: string
  fileName: string
  createdAt: number
  lastAccessAt: number
  /** Makes handing a full `ShareRecord` to a public consumer a type error. */
  passwordHash?: never
}

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
const queue = serialQueue()

// ── Persistence ──────────────────────────────────────────────────────

function normalizeShare(entry: unknown): ShareRecord | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as Record<string, unknown>
  if (
    typeof e.sessionId !== "string"
    || typeof e.dirName !== "string"
    || typeof e.fileName !== "string"
    || typeof e.passwordHash !== "string"
    // Unlike device passwords, share passphrases are only ever stored hashed.
    // A plaintext or empty value here would authenticate whoever guesses it.
    || !isPasswordHashed(e.passwordHash)
  ) return null
  return {
    sessionId: e.sessionId,
    dirName: e.dirName,
    fileName: e.fileName,
    passwordHash: e.passwordHash,
    createdAt: typeof e.createdAt === "number" && Number.isFinite(e.createdAt) ? e.createdAt : 0,
    lastAccessAt:
      typeof e.lastAccessAt === "number" && Number.isFinite(e.lastAccessAt) ? e.lastAccessAt : 0,
  }
}

async function persist(
  filePath: string | null,
  snapshot: readonly ShareRecord[],
): Promise<void> {
  // Silently skipping the write would hand out a passphrase for a share that
  // the first initShareRegistry then discards.
  if (!filePath) throw new Error("Share registry mutated before initShareRegistry")
  await writeOwnerOnlyJson(filePath, snapshot)
}

interface ShareMutation<T> {
  changed: boolean
  value: T
}

function commitShareMutation<T>(
  mutate: (draft: Map<string, ShareRecord>) => ShareMutation<T>,
): Promise<T> {
  return queue.run(async () => {
    const draft = new Map(shares)
    const mutation = mutate(draft)
    if (!mutation.changed) return mutation.value

    // The durable snapshot is created inside the serialized queue turn, and
    // clones each record so a concurrent touchShare cannot alter what is being
    // written. Live state changes only after persistence succeeds, so rejection
    // implicitly rolls the mutation back by discarding this draft.
    const snapshot = [...draft.values()].map((share) => ({ ...share }))
    await persist(registryPath, snapshot)
    replaceAll(shares, draft)
    return mutation.value
  })
}

/**
 * Point the registry at `<dir>/shares.local.json` and load it. A missing or
 * corrupt file yields an empty registry rather than throwing.
 */
export async function initShareRegistry(dir: string): Promise<void> {
  await queue.run(async () => {
    const nextRegistryPath = join(dir, "shares.local.json")
    const loadedShares = await readOwnerOnlyJsonArray(
      nextRegistryPath,
      normalizeShare,
      (share) => share.sessionId,
    )

    registryPath = nextRegistryPath
    replaceAll(shares, loadedShares)
  })
}

// ── Reads ────────────────────────────────────────────────────────────

function toPublicShare(share: ShareRecord): PublicShare {
  // Built field by field: a future secret on ShareRecord stays out by default.
  return {
    sessionId: share.sessionId,
    dirName: share.dirName,
    fileName: share.fileName,
    createdAt: share.createdAt,
    lastAccessAt: share.lastAccessAt,
  }
}

/** Full share record including the hash — for internal (server-side) use only. */
export function getShareWithHash(sessionId: string): ShareRecord | undefined {
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
 * passphrase stops working the moment this resolves. Re-sharing keeps the
 * original `createdAt` so the host list still surfaces long-forgotten shares.
 */
export async function createShare(input: CreateShareInput): Promise<IssuedShare> {
  const passphrase = generatePassphrase()
  const passwordHash = hashPassword(passphrase)
  const share = await commitShareMutation((draft) => {
    const existing = draft.get(input.sessionId)
    const record: ShareRecord = {
      sessionId: input.sessionId,
      dirName: input.dirName,
      fileName: input.fileName,
      passwordHash,
      createdAt: existing?.createdAt ?? Date.now(),
      // No guest has ever used this passphrase; the UI renders 0 as "never".
      lastAccessAt: 0,
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

/**
 * Forget every share in a single registry write. Looping removeShare over
 * listShares would serialize one whole-file rewrite per record for a change
 * with one end state.
 */
export async function clearAllShares(): Promise<void> {
  await commitShareMutation((draft) => {
    if (draft.size === 0) return { changed: false, value: undefined }
    draft.clear()
    return { changed: true, value: undefined }
  })
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
