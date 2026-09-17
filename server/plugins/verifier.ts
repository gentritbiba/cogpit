import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { TargetFile, Updater, type Fetcher } from "tuf-js"
import { parseJsonText } from "./json"

const METADATA_BASE_URL = "https://offline.invalid/metadata/"
const MAX_METADATA_BYTES = 256 * 1024
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_METADATA_FILES = 64
const MAX_ROOT_ROTATIONS = 32
const METADATA_NAME = /^(?:[1-9]\d*\.)?[A-Za-z][A-Za-z0-9_-]*\.json$/
const CHECKPOINT_NAME = /^[A-Za-z][A-Za-z0-9_-]*\.json$/
const DELEGATED_ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,100}$/
const RESERVED_ROLES = new Set(["root", "timestamp", "snapshot", "targets", "prototype", ...Object.getOwnPropertyNames(Object.prototype)])

export interface OfflinePluginBundle {
  roots: Buffer[]
  metadata: Map<string, Buffer>
  payload: Buffer
  targetPath: string
}

export interface VerifiedPluginTarget {
  path: string
  length: number
  hashes: Record<string, string>
  custom: Record<string, unknown>
}

export interface PluginTrustCheckpoint {
  verifiedAt: number
  metadata: Map<string, Buffer>
  verifiedTargets?: Map<string, VerifiedPluginTarget>
  revokedTargets?: Set<string>
}

export interface VerifiedPluginCheckpoint extends PluginTrustCheckpoint {
  verifiedTargets: Map<string, VerifiedPluginTarget>
  revokedTargets: Set<string>
}

export type OfflineVerificationResult =
  | { trusted: true; target: VerifiedPluginTarget; checkpoint: VerifiedPluginCheckpoint }
  | {
      trusted: false
      code: "invalid-bundle" | "clock-rollback" | "metadata-rejected" | "target-missing" | "target-revoked" | "target-changed" | "payload-rejected"
      reason: string
      checkpoint: VerifiedPluginCheckpoint
    }

interface MetadataHeader {
  type: string
  version: number
  signed: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected metadata object")
  return value as Record<string, unknown>
}

function metadataHeader(bytes: Buffer): MetadataHeader {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_METADATA_BYTES) throw new Error("Metadata exceeds byte limit")
  const value = parseJsonText(bytes, MAX_METADATA_BYTES)
  const signed = object(object(value).signed)
  const { version, expires, _type } = signed
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid metadata version")
  if (typeof _type !== "string" || !["root", "timestamp", "snapshot", "targets"].includes(_type)) throw new Error("Invalid metadata role")
  if (typeof expires !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(expires) || !Number.isFinite(Date.parse(expires)) || new Date(expires).toISOString().slice(0, 19) !== expires.slice(0, 19)) {
    throw new Error("Invalid metadata expiry")
  }
  if (_type === "targets" && signed.delegations !== undefined) {
    const delegations = object(signed.delegations)
    if (delegations.roles !== undefined) {
      if (!Array.isArray(delegations.roles)) throw new Error("Invalid metadata delegations")
      for (const role of delegations.roles) {
        const name = object(role).name
        if (typeof name !== "string" || !DELEGATED_ROLE_NAME.test(name) || RESERVED_ROLES.has(name)) throw new Error("Invalid delegated role name")
      }
    }
    if (delegations.succinct_roles !== undefined) throw new Error("Succinct delegations are unsupported in plugin bundles")
  }
  return { type: _type, version, signed }
}

function linkedVersion(header: MetadataHeader, name: string): number {
  const version = object(object(header.signed.meta)[name]).version
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid linked metadata version")
  return version
}

function cacheName(name: string): string {
  return name.replace(/^[1-9]\d*\./, "")
}

function copyCheckpoint(pinnedRoot: Buffer, checkpoint?: PluginTrustCheckpoint): VerifiedPluginCheckpoint {
  const metadata = checkpoint?.metadata ?? new Map([["root.json", pinnedRoot]])
  const targets = checkpoint?.verifiedTargets ?? new Map<string, VerifiedPluginTarget>()
  return {
    verifiedAt: checkpoint?.verifiedAt ?? 0,
    metadata: new Map([...metadata].map(([name, bytes]) => [name, Buffer.from(bytes)])),
    verifiedTargets: new Map([...targets].map(([name, target]) => [name, structuredClone(target)])),
    revokedTargets: new Set(checkpoint?.revokedTargets),
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Offline verification failed"
}

function prepareBundle(bundle: OfflinePluginBundle, checkpoint: VerifiedPluginCheckpoint): Map<string, Buffer> {
  const currentRoot = checkpoint.metadata.get("root.json")
  if (!currentRoot) throw new Error("Trusted checkpoint is missing its root")
  const rootHeader = metadataHeader(currentRoot)
  if (rootHeader.type !== "root") throw new Error("Trusted checkpoint must start with root metadata")
  const rootVersion = rootHeader.version
  if (bundle.roots.length > MAX_ROOT_ROTATIONS) throw new Error("Too many root rotations")
  if (bundle.metadata.size > MAX_METADATA_FILES) throw new Error("Too many metadata files")
  if (!Buffer.isBuffer(bundle.payload)) throw new Error("Expected payload bytes")
  if (!bundle.targetPath || Object.hasOwn(Object.prototype, bundle.targetPath) || bundle.targetPath.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(bundle.targetPath) || bundle.targetPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid target path")
  }
  const files = new Map<string, Buffer>()
  let totalBytes = bundle.payload.length
  for (const [name, bytes] of bundle.metadata) {
    if (name.length > 128 || !METADATA_NAME.test(name) || /(?:^|\.)root\.json$/.test(name)) throw new Error("Invalid offline metadata filename")
    const header = metadataHeader(bytes)
    const roleName = cacheName(name).slice(0, -5)
    const expectedType = ["timestamp", "snapshot"].includes(roleName) ? roleName : "targets"
    if (header.type !== expectedType) throw new Error("Metadata role does not match its filename")
    const previous = checkpoint.metadata.get(cacheName(name))
    if (previous) {
      const priorVersion = metadataHeader(previous).version
      if (header.version < priorVersion) throw new Error(`Metadata rollback for ${name}`)
      if (header.version === priorVersion && !previous.equals(bytes)) throw new Error(`Metadata changed without a version increase: ${name}`)
    }
    files.set(name, Buffer.from(bytes))
    totalBytes += bytes.length
  }
  for (const [index, bytes] of bundle.roots.entries()) {
    const expected = rootVersion + index + 1
    const header = metadataHeader(bytes)
    if (header.type !== "root" || header.version !== expected) throw new Error("Root rotation chain is not contiguous")
    files.set(`${expected}.root.json`, Buffer.from(bytes))
    totalBytes += bytes.length
  }
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Bundle exceeds byte limit")
  const timestamp = files.get("timestamp.json")
  if (!timestamp) throw new Error("Missing offline timestamp")
  const finalRoot = bundle.roots.at(-1) ?? currentRoot
  const consistent = metadataHeader(finalRoot).signed.consistent_snapshot
  const snapshotVersion = linkedVersion(metadataHeader(timestamp), "snapshot.json")
  const snapshot = files.get(consistent ? `${snapshotVersion}.snapshot.json` : "snapshot.json")
  if (!snapshot) throw new Error("Missing offline snapshot")
  const targetsVersion = linkedVersion(metadataHeader(snapshot), "targets.json")
  if (!files.has(consistent ? `${targetsVersion}.targets.json` : "targets.json")) throw new Error("Missing offline targets")
  return files
}

class OfflineMetadataFetcher implements Fetcher {
  constructor(private readonly files: Map<string, Buffer>) {}

  async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    if (!url.startsWith(METADATA_BASE_URL)) throw new Error("Unexpected offline metadata URL")
    const name = url.slice(METADATA_BASE_URL.length)
    const bytes = this.files.get(name)
    if (!bytes) throw new Error(`Missing offline metadata: ${name}`)
    if (bytes.length > Math.min(maxLength, MAX_METADATA_BYTES)) throw new Error(`Metadata exceeds download limit: ${name}`)
    return Buffer.from(bytes)
  }

  async downloadFile<T>(_url: string, _maxLength: number, _handler: (file: string) => Promise<T>): Promise<T> {
    throw new Error("Offline payload downloads are disabled")
  }
}

async function verifyMetadataLinks(checkpoint: VerifiedPluginCheckpoint): Promise<void> {
  for (const parentName of ["timestamp.json", "snapshot.json"]) {
    const parent = checkpoint.metadata.get(parentName)
    if (!parent) continue
    const links = object(metadataHeader(parent).signed.meta)
    for (const [name, linkValue] of Object.entries(links)) {
      const child = checkpoint.metadata.get(name)
      if (!child) continue
      const link = object(linkValue)
      if (metadataHeader(child).version !== link.version) continue
      const hashes = link.hashes === undefined ? {} : object(link.hashes)
      if (Object.values(hashes).some(hash => typeof hash !== "string")) throw new Error("Invalid metadata hashes")
      const length = link.length === undefined ? child.length : link.length
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw new Error("Invalid metadata length")
      await new TargetFile({ path: name, length, hashes: hashes as Record<string, string> }).verify(Readable.from([child]))
    }
  }
}

async function captureCheckpoint(directory: string, checkpoint: VerifiedPluginCheckpoint, startedAt: number): Promise<void> {
  let advanced = false
  for (const name of await readdir(directory)) {
    if (!CHECKPOINT_NAME.test(name)) throw new Error("Unexpected verified metadata filename")
    const bytes = await readFile(join(directory, name))
    const previous = checkpoint.metadata.get(name)
    if (previous?.equals(bytes)) continue
    const version = metadataHeader(bytes).version
    if (previous && version <= metadataHeader(previous).version) throw new Error("Verifier attempted to rewind trusted metadata")
    checkpoint.metadata.set(name, bytes)
    advanced = true
  }
  if (advanced) checkpoint.verifiedAt = Math.max(checkpoint.verifiedAt, startedAt)
}

/** The caller must durably retain the returned checkpoint on success and rejection. */
export async function verifyOffline({ pinnedRoot, bundle, checkpoint: prior }: {
  pinnedRoot: Buffer
  bundle: OfflinePluginBundle
  checkpoint?: PluginTrustCheckpoint
}): Promise<OfflineVerificationResult> {
  const startedAt = Date.now()
  const checkpoint = copyCheckpoint(pinnedRoot, prior)
  if (!Number.isSafeInteger(checkpoint.verifiedAt) || checkpoint.verifiedAt < 0 || startedAt < checkpoint.verifiedAt) {
    return { trusted: false, code: "clock-rollback", reason: "Host clock predates the last verified checkpoint", checkpoint }
  }
  let files: Map<string, Buffer>
  try {
    for (const [name, bytes] of checkpoint.metadata) {
      if (!CHECKPOINT_NAME.test(name)) throw new Error("Invalid trusted checkpoint filename")
      metadataHeader(bytes)
    }
    files = prepareBundle(bundle, checkpoint)
  } catch (error) {
    return { trusted: false, code: "invalid-bundle", reason: reason(error), checkpoint }
  }
  const payload = Buffer.from(bundle.payload)
  const targetPath = bundle.targetPath
  const rootRotations = bundle.roots.length
  const directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-verify-"))
  try {
    // Updater treats cached snapshots as previously verified. Uploads only enter through the fetcher.
    for (const [name, bytes] of checkpoint.metadata) await writeFile(join(directory, name), bytes, { mode: 0o600 })
    let target: Awaited<ReturnType<Updater["getTargetInfo"]>>
    try {
      const updater = new Updater({
        metadataDir: directory,
        metadataBaseUrl: METADATA_BASE_URL,
        fetcher: new OfflineMetadataFetcher(files),
        config: {
          maxRootRotations: rootRotations,
          maxDelegations: checkpoint.metadata.size + files.size,
          rootMaxLength: MAX_METADATA_BYTES,
          timestampMaxLength: MAX_METADATA_BYTES,
          snapshotMaxLength: MAX_METADATA_BYTES,
          targetsMaxLength: MAX_METADATA_BYTES,
        },
      })
      await updater.refresh()
      target = await updater.getTargetInfo(targetPath)
    } catch (error) {
      await captureCheckpoint(directory, checkpoint, startedAt)
      return { trusted: false, code: "metadata-rejected", reason: reason(error), checkpoint }
    }
    await captureCheckpoint(directory, checkpoint, startedAt)
    try {
      await verifyMetadataLinks(checkpoint)
    } catch (error) {
      return { trusted: false, code: "metadata-rejected", reason: reason(error), checkpoint }
    }
    for (const [name, bytes] of files) {
      if (/\.root\.json$/.test(name)) continue
      const accepted = checkpoint.metadata.get(cacheName(name))
      if (accepted && !accepted.equals(bytes)) {
        return { trusted: false, code: "metadata-rejected", reason: `Bundle conflicts with verified metadata: ${name}`, checkpoint }
      }
    }
    checkpoint.verifiedAt = Math.max(checkpoint.verifiedAt, startedAt)
    if (!target) {
      if (checkpoint.verifiedTargets.has(targetPath)) checkpoint.revokedTargets.add(targetPath)
      return { trusted: false, code: "target-missing", reason: "Target is absent from current signed metadata", checkpoint }
    }
    if (checkpoint.revokedTargets.has(targetPath)) {
      return { trusted: false, code: "target-revoked", reason: "Target was previously revoked on this host", checkpoint }
    }
    if (!/^[a-f0-9]{64}$/.test(target.hashes.sha256 ?? "") || !Number.isSafeInteger(target.length)) {
      return { trusted: false, code: "metadata-rejected", reason: "Target requires a SHA-256 digest and integer length", checkpoint }
    }
    const previousTarget = checkpoint.verifiedTargets.get(targetPath)
    if (previousTarget && (previousTarget.length !== target.length || previousTarget.hashes.sha256 !== target.hashes.sha256)) {
      return { trusted: false, code: "target-changed", reason: "A previously verified target path changed its payload", checkpoint }
    }
    const verifiedTarget = { path: target.path, length: target.length, hashes: { ...target.hashes }, custom: structuredClone(target.custom) }
    checkpoint.verifiedTargets.set(targetPath, verifiedTarget)
    try {
      await target.verify(Readable.from([payload]))
    } catch (error) {
      return { trusted: false, code: "payload-rejected", reason: reason(error), checkpoint }
    }
    return { trusted: true, target: verifiedTarget, checkpoint }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
