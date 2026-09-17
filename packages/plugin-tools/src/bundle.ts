import { MetaFile, Snapshot, TargetFile, Targets, Timestamp } from "@tufjs/models"
import type { PluginArchive } from "./archive.js"
import { expiry, serializeMetadata, sha256, signerFor, type PublishedTarget, type PublisherStore } from "./publisher.js"

const SPEC_VERSION = "1.0.31"

export interface SignedBundle {
  /** Contents of the `.cogpit-plugin` file. */
  bytes: Buffer
  targetPath: string
  digest: string
  metadataVersion: number
  /** The publisher store after this signing; persist it so the next bundle continues the sequence. */
  publisher: PublisherStore
}

export interface SignOptions {
  /** How long hosts may keep installing this bundle; retained installs survive expiry. */
  expiresDays?: number
}

export function targetPathFor(archive: Pick<PluginArchive, "manifest">): string {
  const { publisher, id, version } = archive.manifest
  return `${publisher}/${id}/${version}/payload.json`
}

function targetFile(path: string, target: PublishedTarget): TargetFile {
  return new TargetFile({ path, length: target.length, hashes: { sha256: target.sha256 }, unrecognizedFields: { custom: { publisher: target.publisher, pluginId: target.pluginId, version: target.version } } })
}

/**
 * Sign an archive as the next metadata version of a publisher. Every target the
 * publisher signed before stays listed, so hosts keep trusting retained versions
 * instead of treating them as revoked.
 */
export function signBundle(store: PublisherStore, archive: PluginArchive, options: SignOptions = {}): SignedBundle {
  if (archive.manifest.publisher !== store.publisher) throw new Error(`Package publisher ${archive.manifest.publisher} does not match key file publisher ${store.publisher}`)
  const targetPath = targetPathFor(archive)
  const previous = store.targets[targetPath]
  if (previous && previous.sha256 !== archive.digest) {
    throw new Error(`${archive.manifest.id}@${archive.manifest.version} was already signed with different contents; bump the version (or pack with --dev) instead of reusing it`)
  }
  const version = store.metadataVersion + 1
  const expires = expiry(options.expiresDays ?? 365)
  const targets: Record<string, PublishedTarget> = { ...store.targets, [targetPath]: { length: archive.payload.length, sha256: archive.digest, publisher: archive.manifest.publisher, pluginId: archive.manifest.id, version: archive.manifest.version } }
  const targetsRole = new Targets({ specVersion: SPEC_VERSION, version, expires })
  for (const [path, target] of Object.entries(targets)) targetsRole.addTarget(targetFile(path, target))
  const targetsBytes = serializeMetadata(targetsRole, [signerFor(store.keys.targets)])
  const snapshot = new Snapshot({ specVersion: SPEC_VERSION, version, expires, meta: { "targets.json": new MetaFile({ version, length: targetsBytes.length, hashes: { sha256: sha256(targetsBytes) } }) } })
  const snapshotBytes = serializeMetadata(snapshot, [signerFor(store.keys.snapshot)])
  const timestamp = new Timestamp({ specVersion: SPEC_VERSION, version, expires, snapshotMeta: new MetaFile({ version, length: snapshotBytes.length, hashes: { sha256: sha256(snapshotBytes) } }) })
  const metadata = {
    [`${version}.targets.json`]: targetsBytes.toString("utf8"),
    [`${version}.snapshot.json`]: snapshotBytes.toString("utf8"),
    "timestamp.json": serializeMetadata(timestamp, [signerFor(store.keys.timestamp)]).toString("utf8"),
  }
  const bytes = Buffer.from(JSON.stringify({ bundleVersion: 1, publisher: store.publisher, targetPath, roots: [], metadata, payload: archive.payload.toString("base64") }))
  return { bytes, targetPath, digest: archive.digest, metadataVersion: version, publisher: { ...store, metadataVersion: version, targets } }
}
