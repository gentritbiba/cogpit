import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { Key, Metadata, MetadataKind, MetaFile, Root, Signature, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models"
import type { OfflinePluginBundle } from "../../../plugins/verifier"

type RoleName = "root" | "timestamp" | "snapshot" | "targets" | "publisher"
type Signer = (data: Buffer) => Signature
export type Authority = Record<RoleName, { key: Key; signer: Signer }>
type SignedMetadata = Root | Targets | Snapshot | Timestamp
const roles: RoleName[] = ["root", "timestamp", "snapshot", "targets", "publisher"]
const expiry = (expired = false) => new Date(Date.now() + (expired ? -1 : 1) * 86400000).toISOString()
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
export const payload = Buffer.from(JSON.stringify({ files: [{ path: "plugin.js", content: 'document.body.textContent = "Signed sample"' }] }))
export const targetPath = "cogpit/probe/1.0.0/payload.json"

export function createAuthority(): Authority {
  return Object.fromEntries(roles.map(role => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex")
    const keyID = sha256(Buffer.from(publicHex))
    const key = new Key({ keyID, keyType: "ed25519", scheme: "ed25519", keyVal: { public: publicHex } })
    return [role, { key, signer: (data: Buffer) => new Signature({ keyID, sig: sign(null, data, privateKey).toString("hex") }) }]
  })) as Authority
}

export function serialize(signed: SignedMetadata | Metadata<SignedMetadata>, signers: Signer[]): Buffer {
  const value = signed instanceof Metadata ? signed : new Metadata(signed)
  value.signatures = {}
  for (const signer of signers) value.sign(signer, true)
  return Buffer.from(JSON.stringify(value.toJSON()))
}

export function createRoot(authority: Authority, options: { version?: number; previous?: Authority; expired?: boolean } = {}): Buffer {
  const root = new Root({ specVersion: "1.0.31", version: options.version ?? 1, expires: expiry(options.expired), consistentSnapshot: true })
  for (const role of roles.filter(role => role !== "publisher")) root.addKey(authority[role].key, role)
  return serialize(root, [authority.root.signer, ...(options.previous ? [options.previous.root.signer] : [])])
}

export interface FixtureOptions {
  payload?: Buffer
  version?: number
  targetsVersion?: number
  snapshotVersion?: number
  expiredRole?: RoleName
  roots?: Buffer[]
  delegated?: boolean
  revoked?: boolean
}

export function createBundle(authority: Authority, options: FixtureOptions = {}): OfflinePluginBundle {
  const version = options.version ?? 1
  const targetPayload = options.payload ?? payload
  const target = new TargetFile({ path: targetPath, length: targetPayload.length, hashes: { sha256: sha256(targetPayload) }, unrecognizedFields: { custom: { publisher: "cogpit", pluginId: "cogpit.probe", version: "1.0.0" } } })
  const targets = new Targets({ specVersion: "1.0.31", version: options.targetsVersion ?? version, expires: expiry(options.expiredRole === "targets") })
  const files = new Map<string, Buffer>()
  const snapshotMeta: Record<string, MetaFile> = {}
  if (options.delegated) {
    const publisherTargets = new Targets({ specVersion: "1.0.31", version, expires: expiry(options.expiredRole === "publisher") })
    if (!options.revoked) publisherTargets.addTarget(target)
    const publisherBytes = serialize(publisherTargets, [authority.publisher.signer])
    files.set(`${version}.publisher.json`, publisherBytes)
    snapshotMeta["publisher.json"] = new MetaFile({ version, length: publisherBytes.length, hashes: { sha256: sha256(publisherBytes) } })
    const json = new Metadata(targets).toJSON()
    const signed = json.signed as Record<string, any>
    signed.delegations = { keys: { [authority.publisher.key.keyID]: authority.publisher.key.toJSON() }, roles: [{ name: "publisher", keyids: [authority.publisher.key.keyID], threshold: 1, terminating: true, paths: ["cogpit/probe/*/*"] }] }
    files.set(`${targets.version}.targets.json`, serialize(Metadata.fromJSON(MetadataKind.Targets, json), [authority.targets.signer]))
  } else {
    if (!options.revoked) targets.addTarget(target)
    files.set(`${targets.version}.targets.json`, serialize(targets, [authority.targets.signer]))
  }
  const targetsBytes = files.get(`${targets.version}.targets.json`)!
  snapshotMeta["targets.json"] = new MetaFile({ version: targets.version, length: targetsBytes.length, hashes: { sha256: sha256(targetsBytes) } })
  const snapshot = new Snapshot({ specVersion: "1.0.31", version: options.snapshotVersion ?? version, expires: expiry(options.expiredRole === "snapshot"), meta: snapshotMeta })
  const snapshotBytes = serialize(snapshot, [authority.snapshot.signer])
  files.set(`${snapshot.version}.snapshot.json`, snapshotBytes)
  const timestamp = new Timestamp({ specVersion: "1.0.31", version, expires: expiry(options.expiredRole === "timestamp"), snapshotMeta: new MetaFile({ version: snapshot.version, length: snapshotBytes.length, hashes: { sha256: sha256(snapshotBytes) } }) })
  files.set("timestamp.json", serialize(timestamp, [authority.timestamp.signer]))
  return { payload: targetPayload, targetPath, roots: options.roots ?? [], metadata: files }
}

export function mutate(bundle: OfflinePluginBundle, name: string, change: (value: any) => void): OfflinePluginBundle {
  const value = JSON.parse(bundle.metadata.get(name)!.toString("utf8"))
  change(value)
  return { ...bundle, metadata: new Map(bundle.metadata).set(name, Buffer.from(JSON.stringify(value))) }
}

export function resign(bytes: Buffer, kind: MetadataKind, change: (value: any) => void, signers: Signer[]): Buffer {
  const value = JSON.parse(bytes.toString("utf8"))
  change(value)
  const metadata = kind === MetadataKind.Root ? Metadata.fromJSON(MetadataKind.Root, value)
    : kind === MetadataKind.Timestamp ? Metadata.fromJSON(MetadataKind.Timestamp, value)
      : kind === MetadataKind.Snapshot ? Metadata.fromJSON(MetadataKind.Snapshot, value)
        : Metadata.fromJSON(MetadataKind.Targets, value)
  return serialize(metadata, signers)
}

export function replaceTargets(bundle: OfflinePluginBundle, authority: Authority, change: (value: any) => void, signTargets = true): OfflinePluginBundle {
  const files = new Map(bundle.metadata)
  const name = [...files.keys()].find(name => name.endsWith(".targets.json"))!
  const original = files.get(name)!
  const altered = signTargets
    ? resign(original, MetadataKind.Targets, change, [authority.targets.signer])
    : mutate(bundle, name, change).metadata.get(name)!
  files.set(name, altered)
  const snapshotName = [...files.keys()].find(name => name.endsWith(".snapshot.json"))!
  const snapshot = resign(files.get(snapshotName)!, MetadataKind.Snapshot, value => {
    value.signed.meta["targets.json"].hashes.sha256 = sha256(altered)
    value.signed.meta["targets.json"].length = altered.length
  }, [authority.snapshot.signer])
  files.set(snapshotName, snapshot)
  files.set("timestamp.json", resign(files.get("timestamp.json")!, MetadataKind.Timestamp, value => {
    value.signed.meta["snapshot.json"].hashes.sha256 = sha256(snapshot)
    value.signed.meta["snapshot.json"].length = snapshot.length
  }, [authority.timestamp.signer]))
  return { ...bundle, metadata: files }
}
