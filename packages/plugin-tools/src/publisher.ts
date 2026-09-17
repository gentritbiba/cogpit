import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Key, Metadata, Root, Signature, type Snapshot, type Targets, type Timestamp } from "@tufjs/models"

export const ROLES = ["root", "timestamp", "snapshot", "targets"] as const
export type Role = (typeof ROLES)[number]
export const PUBLISHER_NAME = /^dev-[a-z0-9][a-z0-9-]{0,59}$/
const SPEC_VERSION = "1.0.31"
const DAY_MS = 86_400_000

export interface StoredKey {
  keyId: string
  publicHex: string
  privatePem: string
}

export interface PublishedTarget {
  length: number
  sha256: string
  publisher: string
  pluginId: string
  version: string
}

/**
 * Everything a development publisher needs to keep signing: its four TUF role
 * keys, the pinned root document hosts enroll, the metadata version counter
 * that must only grow, and every target it has ever signed so earlier versions
 * stay valid for rollback.
 */
export interface PublisherStore {
  formatVersion: 1
  publisher: string
  createdAt: string
  keys: Record<Role, StoredKey>
  root: string
  metadataVersion: number
  targets: Record<string, PublishedTarget>
}

export interface Signer {
  key: Key
  sign: (data: Buffer) => Signature
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

function keyFromPublicHex(publicHex: string): Key {
  return new Key({ keyID: sha256(Buffer.from(publicHex)), keyType: "ed25519", scheme: "ed25519", keyVal: { public: publicHex } })
}

function generateKey(): StoredKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex")
  return { keyId: keyFromPublicHex(publicHex).keyID, publicHex, privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }
}

export function signerFor(stored: StoredKey): Signer {
  const key = keyFromPublicHex(stored.publicHex)
  const privateKey: KeyObject = createPrivateKey(stored.privatePem)
  return { key, sign: data => new Signature({ keyID: key.keyID, sig: sign(null, data, privateKey).toString("hex") }) }
}

export type SignedRole = Root | Targets | Snapshot | Timestamp

export function serializeMetadata(value: SignedRole, signers: Signer[]): Buffer {
  const metadata = new Metadata(value)
  for (const signer of signers) metadata.sign(signer.sign, true)
  return Buffer.from(JSON.stringify(metadata.toJSON()))
}

export function expiry(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString()
}

/** Create a development publisher with fresh role keys and a version 1 root. */
export function createPublisher(publisher: string, options: { rootExpiresDays?: number } = {}): PublisherStore {
  if (!PUBLISHER_NAME.test(publisher)) throw new Error("Development publishers must be named dev-<lowercase letters, digits or dashes>")
  const keys = Object.fromEntries(ROLES.map(role => [role, generateKey()])) as Record<Role, StoredKey>
  const root = new Root({ specVersion: SPEC_VERSION, version: 1, expires: expiry(options.rootExpiresDays ?? 3650), consistentSnapshot: true })
  for (const role of ROLES) root.addKey(signerFor(keys[role]).key, role)
  return { formatVersion: 1, publisher, createdAt: new Date().toISOString(), keys, root: serializeMetadata(root, [signerFor(keys.root)]).toString("utf8"), metadataVersion: 0, targets: {} }
}

/** The SHA-256 a host operator types into the Publishers form, computed over the exact root bytes. */
export function rootFingerprint(store: Pick<PublisherStore, "root">): string {
  return sha256(Buffer.from(store.root, "utf8"))
}

/** Written through a temporary file so an interrupted `pack` never truncates the signing identity. */
export async function savePublisher(path: string, store: PublisherStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${Date.now()}-${process.pid}.publisher.tmp`)
  await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

export async function loadPublisher(path: string): Promise<PublisherStore> {
  const store = JSON.parse(await readFile(path, "utf8")) as PublisherStore
  if (store.formatVersion !== 1 || !PUBLISHER_NAME.test(store.publisher) || !ROLES.every(role => store.keys?.[role]?.privatePem)) throw new Error(`Not a publisher key file: ${path}`)
  return store
}
