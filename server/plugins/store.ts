import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdtemp, readdir, realpath, rename, rm, statfs } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Updater } from "tuf-js"
import { gt } from "semver"
import { captureAppSeeds, type InspectedAppSeed, type AppSeedProvenance } from "./seeds"
import { LEGACY_PLUGIN_ALIASES, legacyHostSchema, remainingLegacyPluginIds } from "./legacyHost"
import { evaluateCompatibility, parseClientRuntimeDescriptor } from "@cogpit/plugin-contracts"
import { z } from "zod"
import type { InstalledPlugin, PluginInstallPreview, PluginScope, PluginStoreSnapshot } from "../../shared/contracts/plugins"
import { decodeBase64, decodeInstallBundle, inspectPackage, type InstallBundle, type InspectedPackage } from "./package"
import { verifyOffline, type PluginTrustCheckpoint, type VerifiedPluginCheckpoint } from "./verifier"
import { parseJsonText } from "./json"
import { acquirePluginStoreLock, type PluginStoreLock } from "./lock"
import { documentBytes, durableWrite, ensureDirectory, exists, isWriteTemporary, regularFile, removeDurably, STORE_DOCUMENT_LIMIT, syncDirectory } from "./durable"
import { initialRegistry, initialTrust, installedOf, journalSchema, PluginStoreError, previewOf, registrySchema, scopeSchema, trustSchema, type PluginAuthorize, type PluginJournal, type PluginMutationOptions, type PluginDataDeletion, type PluginRegistry, type PluginStageOptions, type PluginStoreOptions, type PluginTrustDocument, type StoredCheckpoint } from "./storeTypes"

export type { PluginAuthorize, PluginMutationOptions, PluginStageOptions, PluginStoreOptions } from "./storeTypes"
export { PluginStoreError } from "./storeTypes"
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 1000) : "Plugin store operation failed"
const initializationSchema = z.strictObject({ formatVersion: z.literal(1), minWriterVersion: z.literal(1), registry: registrySchema, trust: trustSchema })
const MAX_PACKAGES_BYTES = 256 * 1024 * 1024
const MAX_PACKAGES = 256
const MAX_PENDING = 32
export const MAX_RETAINED_VERSIONS = 8
const COORDINATION_DEADLINE_MS = 30000

function encodeCheckpoint(checkpoint: VerifiedPluginCheckpoint): StoredCheckpoint {
  return { verifiedAt: checkpoint.verifiedAt, metadata: Object.fromEntries([...checkpoint.metadata].map(([name, bytes]) => [name, bytes.toString("base64")])), verifiedTargets: Object.fromEntries(checkpoint.verifiedTargets), revokedTargets: [...checkpoint.revokedTargets] }
}
function decodeCheckpoint(checkpoint?: StoredCheckpoint): PluginTrustCheckpoint | undefined {
  if (!checkpoint) return undefined
  const metadata = new Map(Object.entries(checkpoint.metadata).map(([name, text]) => [name, decodeBase64(text, 256 * 1024)]))
  for (const bytes of metadata.values()) parseJsonText(bytes, 256 * 1024)
  return { verifiedAt: checkpoint.verifiedAt, metadata, verifiedTargets: new Map(Object.entries(checkpoint.verifiedTargets)), revokedTargets: new Set(checkpoint.revokedTargets) }
}
function rootVersion(bytes: Buffer): number {
  const root = z.object({ signed: z.object({ _type: z.literal("root"), version: z.number().int().positive(), expires: z.string() }) }).parse(parseJsonText(bytes, 256 * 1024))
  if (!Number.isFinite(Date.parse(root.signed.expires))) throw new Error("Invalid publisher root expiry")
  return root.signed.version
}
function input<T>(parse: () => T): T {
  try { return parse() } catch (error) { throw new PluginStoreError("INVALID_PACKAGE", message(error)) }
}

export class PluginStore {
  private registry: PluginRegistry = initialRegistry()
  private trust: PluginTrustDocument = initialTrust()
  private journals = new Map<string, PluginJournal>()
  private appSeeds: ReadonlyMap<string, InspectedAppSeed> = new Map()
  private delivered = new Set<string>()
  private lock?: PluginStoreLock
  private available = false
  private error?: string
  private recoveryCode: PluginStoreSnapshot["recoveryCode"] = "STORE_UNAVAILABLE"
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private constructor(private root: string, private readonly options: PluginStoreOptions) {}

  static async open(root: string, options: PluginStoreOptions): Promise<PluginStore> {
    const capturedRoot = resolve(root)
    const store = new PluginStore(capturedRoot, { ...options, host: structuredClone(options.host), officialRoots: new Map([...options.officialRoots ?? []].map(([id, bytes]) => [id, Buffer.from(bytes)])) })
    try {
      store.appSeeds = captureAppSeeds(options.appSeeds)
      await ensureDirectory(capturedRoot)
      store.root = await realpath(capturedRoot)
      store.lock = await acquirePluginStoreLock(store.root, reason => store.compromised(reason))
      await store.initialize()
      store.options.afterMutation?.()
      store.available = true
    } catch (error) {
      store.error = message(error)
      store.recoveryCode = /newer format/.test(store.error) ? "STORE_VERSION" : /lock|owner|another host/.test(store.error) ? "STORE_LOCKED" : "STORE_CORRUPT"
      await store.lock?.release().catch(() => undefined)
      store.lock = undefined
    }
    return store
  }

  snapshot(): PluginStoreSnapshot {
    if (!this.available || this.closed) return { available: false, error: this.error ?? "Plugin store is closed", recoveryCode: this.recoveryCode, revision: this.registry.revision, plugins: [], publishers: [], legacyPluginIds: [], availableSeeds: [] }
    const publishers = new Map(Object.entries(this.trust.publishers).map(([id, publisher]) => [id, { id, label: publisher.label, kind: publisher.kind, fingerprint: sha256(decodeBase64(publisher.pinnedRoot, 256 * 1024)), ...(publisher.checkpoint ? { verifiedAt: publisher.checkpoint.verifiedAt } : {}) }]))
    for (const seed of Object.values(this.trust.appSeeds ?? {})) if (!publishers.has(seed.publisher)) publishers.set(seed.publisher, { id: seed.publisher, label: `${seed.publisher} (bundled with Cogpit)`, kind: "official", fingerprint: seed.digest })
    return { available: this.available && !this.closed, ...(this.error ? { error: this.error } : {}), revision: this.registry.revision,
      plugins: Object.values(this.registry.plugins).map(plugin => ({ ...installedOf(plugin), versions: plugin.versions.map(version => {
        const unavailableReason = this.registry.quarantined?.[version.digest]?.reason
          ?? (this.trust.publishers[version.manifest.publisher]?.checkpoint?.revokedTargets.includes(version.targetPath) ? "This retained package was revoked" : undefined)
        return { ...structuredClone(version), ...(unavailableReason ? { unavailableReason } : {}) }
      }) })).sort((a, b) => a.id.localeCompare(b.id)),
      publishers: [...publishers.values()].sort((a, b) => a.id.localeCompare(b.id)),
      legacyPluginIds: remainingLegacyPluginIds(this.options.legacyHost?.classification === "indeterminate" ? this.options.legacyHost : this.registry.seedMigration?.classification, this.registry.seedMigration?.decisions),
      availableSeeds: [...this.appSeeds.values()].map(seed => ({ manifest: structuredClone(seed.inspected.manifest), digest: seed.inspected.digest })),
    }
  }

  private compromised(reason: string): void {
    this.available = false
    this.error = reason
    this.recoveryCode = "STORE_UNAVAILABLE"
    try { this.options.onCompromised?.(reason) } catch { /* A plugin failure must not terminate the host. */ }
  }
  private requireAvailable(): void {
    if (!this.available || this.closed) throw new PluginStoreError("STORE_UNAVAILABLE", this.error ?? "Plugin store is closed")
  }
  private async authorize(authorize: PluginAuthorize): Promise<void> {
    try { await authorize() } catch (error) { throw new PluginStoreError("FORBIDDEN", message(error)) }
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.requireAvailable()
      try { await this.lock!.assertOwned(); return await operation() }
      catch (error) { if (!(error instanceof PluginStoreError)) this.compromised(message(error)); throw error }
      finally { this.options.afterMutation?.() }
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private async write(name: string, value: unknown, label: string, authorize?: PluginAuthorize, validate?: () => void): Promise<void> {
    await durableWrite(join(this.root, name), documentBytes(value), { label, guard: async () => { await this.lock!.assertOwned(); if (authorize) await this.authorize(authorize); validate?.() }, hook: this.options.crashHook })
  }
  private async read<T>(name: string, schema: z.ZodType<T>): Promise<T> {
    const value = parseJsonText(await regularFile(join(this.root, name)), STORE_DOCUMENT_LIMIT)
    const format = z.object({ formatVersion: z.number(), minWriterVersion: z.number() }).passthrough().safeParse(value)
    if (format.success && (format.data.formatVersion > 1 || format.data.minWriterVersion > 1)) throw new Error("Plugin store uses a newer format; upgrade Cogpit before opening it")
    return schema.parse(value)
  }
  private async initialize(): Promise<void> {
    const initializing = await exists(join(this.root, "initialize.json"))
    const hasRegistry = await exists(join(this.root, "registry.json"))
    const hasTrust = await exists(join(this.root, "trust.json"))
    if (initializing) {
      const initial = await this.read("initialize.json", initializationSchema)
      for (const [name, value] of [["registry.json", initial.registry], ["trust.json", initial.trust]] as const) {
        if (await exists(join(this.root, name))) {
          if (!(await regularFile(join(this.root, name))).equals(documentBytes(value))) throw new Error("Initialization journal conflicts with the plugin store")
        } else await this.write(name, value, `initialize-${name}`)
      }
      await removeDurably(join(this.root, "initialize.json"))
    } else if (!hasRegistry && !hasTrust) {
      const unexpected = (await readdir(this.root)).filter(name => ![".store.lock", "owner.json"].includes(name) && !isWriteTemporary(name))
      if (unexpected.length) throw new Error("Plugin store metadata is missing from a nonempty store")
      const initial = { formatVersion: 1, minWriterVersion: 1, registry: initialRegistry(), trust: initialTrust() }
      await this.write("initialize.json", initial, "initialize-intent")
      await this.write("registry.json", initial.registry, "initialize-registry")
      await this.write("trust.json", initial.trust, "initialize-trust")
      await removeDurably(join(this.root, "initialize.json"))
    } else if (!hasRegistry || !hasTrust) throw new Error("Plugin registry or retained trust metadata is missing")
    this.registry = await this.read("registry.json", registrySchema)
    this.trust = await this.read("trust.json", trustSchema)
    for (const directory of ["packages", "transactions", "staging", "quarantine"]) await ensureDirectory(join(this.root, directory))
    if (process.platform !== "win32") await chmod(join(this.root, "quarantine"), 0o700)
    for (const publisher of Object.values(this.trust.publishers)) {
      await this.validateRoot(decodeBase64(publisher.pinnedRoot, 256 * 1024))
      decodeCheckpoint(publisher.checkpoint)
    }
    await this.validateRegistry()
    let trustChanged = false
    for (const [id, root] of this.options.officialRoots ?? []) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || id.startsWith("dev-")) throw new Error("Invalid official publisher namespace")
      await this.validateRoot(root)
      const existing = Object.hasOwn(this.trust.publishers, id) ? this.trust.publishers[id] : undefined
      if (existing && existing.kind !== "official") throw new Error("Official publisher conflicts with an enrolled developer")
      if (!existing) { this.trust.publishers[id] = { kind: "official", label: id, pinnedRoot: root.toString("base64") }; trustChanged = true }
    }
    const filenames = await readdir(join(this.root, "transactions"))
    if (filenames.length > 2048) throw new Error("Too many plugin transaction records")
    for (const name of filenames) {
      if (isWriteTemporary(name)) continue
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Unknown file in plugin transaction directory")
      const journal = await this.read(`transactions/${name}`, journalSchema)
      if (`${journal.id}.json` !== name) throw new Error("Plugin transaction filename differs from its identity")
      this.journals.set(journal.id, journal)
    }
    if (trustChanged) await this.write("trust.json", trustSchema.parse(this.trust), "official-roots")
    for (const journal of this.journals.values()) {
      if (journal.status === "committing") {
        if (!journal.nextRegistry) throw new Error("Committing transaction has no registry decision")
        if (documentBytes(this.registry).equals(documentBytes(journal.nextRegistry))) journal.status = "committed"
        else if (this.registry.revision === journal.registryRevision) { journal.status = "cancelled"; journal.reason = "Host stopped before package promotion" }
        else throw new Error("Plugin transaction cannot be reconciled with the registry")
        delete journal.nextRegistry
        await this.saveJournal(journal, "recover-commit")
      } else if (journal.status === "prepared" || journal.status === "trial") {
        journal.status = "cancelled"; journal.reason = "Trial coordinator was lost when the host stopped"
        await this.saveJournal(journal, "recover-trial")
      }
    }
    for (const plugin of Object.values(this.registry.plugins)) for (const version of plugin.versions) {
      try {
        const inspected = inspectPackage(await this.readPayload(version.digest), version.manifest.publisher)
        if (JSON.stringify(inspected.manifest) !== JSON.stringify(version.manifest)) throw new Error("Retained plugin manifest differs from its payload")
      } catch (error) { if (!(error instanceof PluginStoreError) || error.code !== "PACKAGE_UNAVAILABLE") throw error }
    }
    const revoked = Object.values(this.registry.plugins).filter(plugin => {
      const publisher = this.trust.publishers[plugin.manifest.publisher]
      return publisher?.checkpoint?.revokedTargets.includes(this.selectedVersion(plugin).targetPath)
    })
    if (revoked.some(plugin => plugin.enabled)) {
      const next = structuredClone(this.registry)
      for (const plugin of revoked) { await this.options.beforeChange?.(plugin.id, "revoked"); next.plugins[plugin.id].enabled = false; next.plugins[plugin.id].lastError = "The selected package was revoked" }
      next.revision++
      await this.write("registry.json", registrySchema.parse(next), "recover-revocation")
      this.registry = next
    }
    if (!this.registry.seedMigration?.classification && this.options.legacyHost) {
      this.registry.seedMigration ??= { decisions: {} }
      this.registry.seedMigration.classification = legacyHostSchema.parse(this.options.legacyHost)
      await this.write("registry.json", registrySchema.parse(this.registry), "host-classification")
    }
    for (const directory of [this.root, join(this.root, "packages"), join(this.root, "transactions")]) {
      for (const name of await readdir(directory)) {
        if (!isWriteTemporary(name)) continue
        const path = join(directory, name)
        await regularFile(path)
        await this.lock!.assertOwned()
        await removeDurably(path)
      }
    }
  }
  private async validateRoot(root: Buffer): Promise<void> {
    rootVersion(root)
    const directory = await mkdtemp(join(this.root, "staging", "root-"))
    try {
      await durableWrite(join(directory, "root.json"), root, { label: "validate-root", guard: () => this.lock!.assertOwned() })
      new Updater({ metadataDir: directory, metadataBaseUrl: "https://offline.invalid/", config: { maxRootRotations: 0 } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  private selectedVersion(plugin: InstalledPlugin) {
    const version = plugin.versions.find(version => version.digest === plugin.selectedDigest)
    if (!version) throw new Error("Plugin selected package is absent from retained versions")
    return version
  }
  private async validateRegistry(): Promise<void> {
    for (const [id, plugin] of Object.entries(this.registry.plugins)) {
      if (id !== plugin.id || id !== plugin.manifest.id) throw new Error("Plugin registry identity mismatch")
      const selected = this.selectedVersion(plugin)
      if (JSON.stringify(selected.manifest) !== JSON.stringify(plugin.manifest)) throw new Error("Plugin selected manifest mismatch")
      if (!Object.hasOwn(this.trust.publishers, plugin.manifest.publisher) && !this.seedProvenance(selected.digest, selected.manifest.id, selected.targetPath)) throw new Error("Plugin publisher trust record is missing")
      if (!this.registry.dataSchemas[id]?.every(version => version === plugin.manifest.stateVersion)) throw new Error("Plugin retained data schemas are inconsistent")
      for (const version of plugin.versions) {
        if (version.manifest.id !== id || this.registry.identities[`${id}@${version.manifest.version}`] !== version.digest) throw new Error("Plugin immutable identity record is inconsistent")
        if (!Object.hasOwn(this.trust.publishers, version.manifest.publisher) && !this.seedProvenance(version.digest, version.manifest.id, version.targetPath)) throw new Error("Retained package trust provenance is missing")
      }
    }
  }
  private async readPayload(digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new PluginStoreError("NOT_FOUND", "Unknown package digest")
    if (this.registry.quarantined?.[digest]) throw new PluginStoreError("PACKAGE_UNAVAILABLE", this.registry.quarantined[digest].reason)
    try {
      const bytes = await regularFile(join(this.root, "packages", `${digest}.json`))
      if (sha256(bytes) !== digest) throw new Error("Invalid package digest")
      return bytes
    } catch {
      const reason = "Retained package bytes are missing or corrupt; select another verified version"
      const next = structuredClone(this.registry)
      next.quarantined ??= {}; next.quarantined[digest] = { reason, detectedAt: Date.now() }
      for (const plugin of Object.values(next.plugins)) if (plugin.selectedDigest === digest) {
        await this.options.beforeChange?.(plugin.id, "quarantine")
        plugin.enabled = false; plugin.lastError = reason
      }
      next.revision++
      await this.write("registry.json", registrySchema.parse(next), "quarantine-registry")
      this.registry = next
      throw new PluginStoreError("PACKAGE_UNAVAILABLE", reason)
    }
  }
  private async savePayload(inspected: InspectedPackage, authorize: PluginAuthorize): Promise<void> {
    const filename = join(this.root, "packages", `${inspected.digest}.json`)
    const quarantine = this.registry.quarantined?.[inspected.digest]
    const repairing = quarantine !== undefined
    if (await exists(filename) && !repairing) { if (!(await this.readPayload(inspected.digest)).equals(inspected.payload)) throw new Error("Immutable package digest collision"); return }
    let used = 0, count = 0
    for (const directory of ["packages", "quarantine"]) for (const name of await readdir(join(this.root, directory))) {
      const stat = await lstat(join(this.root, directory, name))
      if (directory === "packages") {
        if (isWriteTemporary(name)) continue
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unknown file in immutable package store")
        if ((!stat.isFile() || stat.isSymbolicLink()) && !this.registry.quarantined?.[name.slice(0, -5)]) throw new Error("Immutable package is not a regular file")
      }
      if (stat.isDirectory()) throw new PluginStoreError("PACKAGE_UNAVAILABLE", "Plugin package recovery requires inspection of an unexpected directory")
      used += stat.size; count++
    }
    if (count >= MAX_PACKAGES || used + inspected.payload.length > MAX_PACKAGES_BYTES) throw new PluginStoreError("QUOTA_EXCEEDED", "Plugin package retention quota is full")
    const free = await statfs(this.root)
    if (free.bavail * free.bsize < inspected.payload.length + 1024 * 1024) throw new PluginStoreError("DISK_FULL", "Insufficient space for the plugin transaction")
    const guard = async () => { await this.lock!.assertOwned(); await this.authorize(authorize) }
    if (repairing && await exists(filename)) {
      await guard()
      await rename(filename, join(this.root, "quarantine", `${inspected.digest}-${randomUUID()}.json`))
      await this.options.crashHook?.("repair-quarantine:renamed")
      await syncDirectory(join(this.root, "quarantine")); await syncDirectory(join(this.root, "packages"))
      await this.options.crashHook?.("repair-quarantine:directory-synced")
    }
    await durableWrite(filename, inspected.payload, { label: "package", guard, hook: this.options.crashHook })
    if (repairing) {
      const next = structuredClone(this.registry)
      delete next.quarantined![inspected.digest]; next.revision++
      for (const plugin of Object.values(next.plugins)) if (plugin.selectedDigest === inspected.digest && plugin.lastError === quarantine.reason) delete plugin.lastError
      await this.write("registry.json", registrySchema.parse(next), "repair-registry", authorize)
      this.registry = next
    }
  }
  private async saveJournal(journal: PluginJournal, label: string, authorize?: PluginAuthorize): Promise<void> {
    if (journal.status === "prepared" && !this.journals.has(journal.id)) {
      const previous = this.registry.plugins[journal.manifest.id]
      if (previous) {
        journal.previousManifest = structuredClone(previous.manifest)
        try { journal.previousConnectionDefinitions = [...inspectPackage(await this.readPayload(previous.selectedDigest), previous.manifest.publisher).connections.values()] }
        catch (error) { if (!(error instanceof PluginStoreError) || error.code !== "PACKAGE_UNAVAILABLE") throw error }
        journal.registryRevision = this.registry.revision
      }
    }
    await this.write(`transactions/${journal.id}.json`, journalSchema.parse(journal), label, authorize)
    this.journals.set(journal.id, journal)
  }
  private async pruneTransactions(): Promise<void> {
    const now = Date.now()
    for (const original of this.journals.values()) {
      const journal = structuredClone(original)
      if ((journal.status === "prepared" && journal.createdAt + 30 * 60_000 < now) || (journal.status === "trial" && (journal.deadline ?? 0) < now)) {
        journal.status = "cancelled"; journal.reason = "Candidate review or trial expired"
        await this.saveJournal(journal, "expire-transaction")
        this.delivered.delete(journal.id)
      }
      if (["committed", "cancelled"].includes(journal.status) && journal.createdAt + 7 * 86400_000 < now) {
        await this.lock!.assertOwned()
        await removeDurably(join(this.root, "transactions", `${journal.id}.json`))
        this.journals.delete(journal.id)
      }
    }
    await this.collectPackages()
    if (this.journals.size >= 2048 || [...this.journals.values()].filter(journal => ["prepared", "trial", "committing"].includes(journal.status)).length >= MAX_PENDING) throw new PluginStoreError("QUOTA_EXCEEDED", "Plugin transaction retention limit reached")
  }
  private async collectPackages(cancelledDigest?: string): Promise<void> {
    const referenced = new Set(Object.values(this.registry.plugins).flatMap(plugin => plugin.versions.map(version => version.digest)))
    for (const journal of this.journals.values()) if (journal.status !== "cancelled") referenced.add(journal.digest)
    for (const name of await readdir(join(this.root, "packages"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const digest = name.slice(0, -5)
      if (referenced.has(digest) || this.registry.quarantined?.[digest]) continue
      const path = join(this.root, "packages", name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Immutable package is not a regular file")
      if (digest !== cancelledDigest && stat.mtimeMs + 7 * 86400_000 >= Date.now()) continue
      await this.lock!.assertOwned()
      await removeDurably(path)
    }
  }
  private checkRevision(expected: number): void {
    if (expected !== this.registry.revision) throw new PluginStoreError("STALE_REVISION", "Plugin registry changed; review the candidate again")
  }
  private checkDeadline(journal: PluginJournal): void {
    if (journal.deadline === undefined || Date.now() > journal.deadline || Date.now() < journal.createdAt) throw new PluginStoreError("TRIAL_EXPIRED", "Candidate readiness trial is missing or expired")
  }
  private checkState(manifest: InspectedPackage["manifest"], digest: string, rollback = false, verifiedRepair = false): void {
    const existing = this.registry.plugins[manifest.id]
    if (this.registry.pendingDataDeletions?.some(deletion => deletion.pluginId === manifest.id)) throw new PluginStoreError("DATA_CLEARING", "Plugin data deletion is still being completed")
    if (this.registry.quarantined?.[digest] && !verifiedRepair) throw new PluginStoreError("PACKAGE_UNAVAILABLE", "This retained package is quarantined")
    if (!existing && Object.keys(this.registry.plugins).length >= 256) throw new PluginStoreError("QUOTA_EXCEEDED", "Installed plugin limit reached")
    if (existing?.pinned && existing.selectedDigest !== digest) throw new PluginStoreError("PINNED", "Unpin this plugin before selecting another package")
    if (!rollback && existing && gt(existing.manifest.version, manifest.version)) throw new PluginStoreError("DOWNGRADE", "Select a retained version through rollback to downgrade this plugin")
    if (this.registry.dataSchemas[manifest.id]?.some(version => version !== manifest.stateVersion)) throw new PluginStoreError("STATE_VERSION", "Package state schema differs from retained project data")
    const identity = this.registry.identities[`${manifest.id}@${manifest.version}`]
    if (identity && identity !== digest) throw new PluginStoreError("IMMUTABLE_VERSION", "This plugin version was previously bound to different bytes")
    if (rollback && !existing?.versions.some(version => version.digest === digest)) throw new PluginStoreError("NOT_FOUND", "Rollback package is not retained")
  }
  private journalFor(id: string, owner: string): PluginJournal {
    if (!owner || owner.length > 1024) throw new PluginStoreError("FORBIDDEN", "Missing transaction owner")
    const journal = this.journals.get(id)
    if (!journal || journal.ownerHash !== sha256(owner)) throw new PluginStoreError("NOT_FOUND", "Transaction is not owned by this client")
    return structuredClone(journal)
  }
  private async auditSelected(bundle: InstallBundle, checkpoint: VerifiedPluginCheckpoint): Promise<{ checkpoint: VerifiedPluginCheckpoint; revoked: string[] }> {
    const revoked: string[] = []
    for (const plugin of Object.values(this.registry.plugins).filter(plugin => plugin.manifest.publisher === bundle.publisher)) {
      for (const retained of plugin.versions) {
        let payload: Buffer
        try { payload = await this.readPayload(retained.digest) } catch (error) { if (error instanceof PluginStoreError && error.code === "PACKAGE_UNAVAILABLE") continue; throw error }
        const currentRoot = checkpoint.metadata.get("root.json")!
        const result = await verifyOffline({ pinnedRoot: currentRoot, checkpoint, bundle: { ...bundle, roots: bundle.roots.filter(root => rootVersion(root) > rootVersion(currentRoot)), targetPath: retained.targetPath, payload } })
        checkpoint = result.checkpoint
        if (!result.trusted && ["target-missing", "target-revoked", "target-changed"].includes(result.code)) { checkpoint.revokedTargets.add(retained.targetPath); if (retained.digest === plugin.selectedDigest) revoked.push(plugin.id) }
      }
    }
    return { checkpoint, revoked }
  }
  private retainedBundle(publisher: string, targetPath: string, payload: Buffer): InstallBundle {
    const checkpoint = decodeCheckpoint(this.trust.publishers[publisher].checkpoint)
    if (!checkpoint?.metadata.has("root.json")) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Publisher has no retained verification checkpoint")
    const shape = z.object({ signed: z.object({ version: z.number().int().positive(), consistent_snapshot: z.boolean().optional(), meta: z.record(z.string(), z.unknown()).optional() }) })
    const root = shape.parse(parseJsonText(checkpoint.metadata.get("root.json")!, 256 * 1024))
    const snapshotBytes = checkpoint.metadata.get("snapshot.json")
    const roleNames = new Set(["timestamp.json", "snapshot.json", ...Object.keys(snapshotBytes ? shape.parse(parseJsonText(snapshotBytes, 256 * 1024)).signed.meta ?? {} : {})])
    const metadata = new Map<string, Buffer>()
    for (const name of roleNames) {
      const bytes = checkpoint.metadata.get(name)
      if (!bytes) continue
      const version = shape.parse(parseJsonText(bytes, 256 * 1024)).signed.version
      metadata.set(name === "timestamp.json" || !root.signed.consistent_snapshot ? name : `${version}.${name}`, bytes)
    }
    return { publisher, targetPath, payload, roots: [], metadata }
  }
  private seedProvenance(digest: string, id: string, targetPath: string): AppSeedProvenance | undefined {
    const seed = this.trust.appSeeds?.[digest]
    return seed?.pluginId === id && seed.targetPath === targetPath && seed.digest === digest ? seed : undefined
  }
  private async reverifyCandidate(journal: PluginJournal, payload: Buffer, authorize: PluginAuthorize): Promise<void> {
    const publisher = this.trust.publishers[journal.manifest.publisher]
    if (journal.operation === "rollback") {
      const retained = this.registry.plugins[journal.manifest.id]?.versions.find(version => version.digest === journal.digest && version.targetPath === journal.targetPath)
      const verified = publisher?.checkpoint?.verifiedTargets[journal.targetPath]
      const seed = this.seedProvenance(journal.digest, journal.manifest.id, journal.targetPath)
      if (!retained || this.registry.identities[`${journal.manifest.id}@${journal.manifest.version}`] !== journal.digest || sha256(payload) !== journal.digest
        || !seed && (!verified || verified.hashes.sha256 !== journal.digest || verified.length !== payload.length)) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Rollback requires the exact previously verified retained package")
      if (publisher?.checkpoint?.revokedTargets.includes(journal.targetPath)) throw new PluginStoreError("REVOKED", "Rollback package is revoked")
      return
    }
    if (journal.appSeed) {
      const seed = this.seedProvenance(journal.digest, journal.manifest.id, journal.targetPath)
      if (!seed || JSON.stringify(seed) !== JSON.stringify(journal.appSeed) || seed.publisher !== journal.manifest.publisher
        || seed.version !== journal.manifest.version || sha256(payload) !== seed.digest) throw new PluginStoreError("UNTRUSTED_PACKAGE", "App seed provenance no longer matches the exact package")
      if (!publisher?.checkpoint) return
    }
    if (!publisher) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Publisher trust root is unavailable")
    const bundle = this.retainedBundle(journal.manifest.publisher, journal.targetPath, payload)
    const verification = await verifyOffline({ pinnedRoot: decodeBase64(publisher.pinnedRoot, 256 * 1024), checkpoint: decodeCheckpoint(publisher.checkpoint), bundle })
    const audited = await this.auditSelected(bundle, verification.checkpoint)
    await this.retainTrust(bundle.publisher, audited.checkpoint, audited.revoked, authorize)
    if (!verification.trusted) throw new PluginStoreError("UNTRUSTED_PACKAGE", verification.reason)
    if (verification.target.hashes.sha256 !== journal.digest) throw new PluginStoreError("IMMUTABLE_VERSION", "Candidate no longer matches authenticated metadata")
  }
  private async retainTrust(publisher: string, checkpoint: VerifiedPluginCheckpoint, revoked: string[], authorize: PluginAuthorize): Promise<void> {
    const nextTrust = structuredClone(this.trust)
    nextTrust.publishers[publisher].checkpoint = encodeCheckpoint(checkpoint)
    await this.authorize(authorize)
    await this.write("trust.json", trustSchema.parse(nextTrust), "trust", authorize)
    this.trust = nextTrust
    const disabled = revoked.filter(id => this.registry.plugins[id]?.enabled)
    if (disabled.length) {
      const next = structuredClone(this.registry)
      for (const id of disabled) { await this.options.beforeChange?.(id, "revoked"); next.plugins[id].enabled = false; next.plugins[id].lastError = "The selected package was revoked" }
      next.revision++
      await this.write("registry.json", registrySchema.parse(next), "revoke-registry")
      this.registry = next
    }
  }

  enrollDeveloper(publisher: string, label: string, pinnedRoot: Buffer, options: { authorize: PluginAuthorize }): Promise<PluginStoreSnapshot> {
    const root = Buffer.from(pinnedRoot)
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      if (!/^dev-[a-z0-9][a-z0-9-]{0,59}$/.test(publisher) || !label.trim() || label.length > 100) throw new PluginStoreError("INVALID_PUBLISHER", "Development publishers must use a dev- namespace and a label")
      if (this.trust.publishers[publisher]) throw new PluginStoreError("PUBLISHER_EXISTS", "Publisher namespace is already enrolled")
      try { await this.validateRoot(root) } catch (error) { throw new PluginStoreError("INVALID_ROOT", message(error)) }
      if (Object.keys(this.trust.publishers).length >= 256) throw new PluginStoreError("QUOTA_EXCEEDED", "Publisher enrollment limit reached")
      const next = structuredClone(this.trust)
      next.publishers[publisher] = { kind: "development", label: label.trim(), pinnedRoot: root.toString("base64") }
      await this.authorize(options.authorize)
      await this.write("trust.json", trustSchema.parse(next), "enroll-developer", options.authorize)
      this.trust = next
      return this.snapshot()
    })
  }

  stage(bytes: Buffer, options: PluginStageOptions): Promise<PluginInstallPreview> {
    if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw new PluginStoreError("INVALID_PACKAGE", "Plugin upload exceeds its byte limit")
    const upload = Buffer.from(bytes)
    const scope = input(() => scopeSchema.parse(options.scope))
    const client = input(() => parseClientRuntimeDescriptor(options.client))
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      if (!options.owner || options.owner.length > 1024) throw new PluginStoreError("FORBIDDEN", "Missing transaction owner")
      await this.pruneTransactions()
      const uploadHash = sha256(upload)
      const idempotencyHash = options.idempotencyKey ? sha256(JSON.stringify([options.owner, options.idempotencyKey])) : undefined
      const existing = idempotencyHash && [...this.journals.values()].find(journal => journal.idempotencyHash === idempotencyHash)
      if (existing) {
        if (existing.uploadHash !== uploadHash || JSON.stringify(existing.scope) !== JSON.stringify(scope) || JSON.stringify(existing.client) !== JSON.stringify(client)) throw new PluginStoreError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different candidate")
        return previewOf(existing)
      }
      if ([...this.journals.values()].filter(journal => ["prepared", "trial", "committing"].includes(journal.status)).length >= MAX_PENDING) throw new PluginStoreError("QUOTA_EXCEEDED", "Too many pending plugin transactions")
      const bundle = input(() => decodeInstallBundle(upload))
      const publisher = Object.hasOwn(this.trust.publishers, bundle.publisher) ? this.trust.publishers[bundle.publisher] : undefined
      if (!publisher) throw new PluginStoreError("UNKNOWN_PUBLISHER", "Enroll this development publisher before installing its packages")
      const prior = decodeCheckpoint(publisher.checkpoint)
      const pinnedRoot = decodeBase64(publisher.pinnedRoot, 256 * 1024)
      const currentRoot = prior?.metadata.get("root.json") ?? pinnedRoot
      const currentVersion = rootVersion(currentRoot)
      bundle.roots = input(() => bundle.roots.filter(root => {
        const version = rootVersion(root)
        if (version === currentVersion && !root.equals(currentRoot)) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Bundle conflicts with the retained trust root")
        return version > currentVersion
      }))
      const verification = await verifyOffline({ pinnedRoot, bundle, checkpoint: prior })
      const audited = await this.auditSelected(bundle, verification.checkpoint)
      await this.retainTrust(bundle.publisher, audited.checkpoint, audited.revoked, options.authorize)
      if (!verification.trusted) throw new PluginStoreError("UNTRUSTED_PACKAGE", verification.reason)
      const inspected = input(() => inspectPackage(bundle.payload, bundle.publisher))
      const custom = verification.target.custom
      if ((custom.publisher !== undefined && custom.publisher !== bundle.publisher) || (custom.pluginId !== undefined && custom.pluginId !== inspected.manifest.id) || (custom.version !== undefined && custom.version !== inspected.manifest.version)) throw new PluginStoreError("IDENTITY_MISMATCH", "Signed target identity differs from the package manifest")
      this.checkState(inspected.manifest, inspected.digest, false, true)
      await this.savePayload(inspected, options.authorize)
      await this.authorize(options.authorize)
      const journal: PluginJournal = { formatVersion: 1, minWriterVersion: 1, id: randomUUID(), ownerHash: sha256(options.owner), status: "prepared", createdAt: Date.now(), registryRevision: this.registry.revision, manifest: inspected.manifest, digest: inspected.digest, targetPath: bundle.targetPath, publisherKind: publisher.kind, oldVersion: this.registry.plugins[inspected.manifest.id]?.manifest.version ?? null, scope, client, compatibility: evaluateCompatibility(inspected.manifest, client, { ...this.options.host, registryRevision: this.registry.revision }, { allowPrerelease: publisher.kind === "development" }), ...(idempotencyHash ? { idempotencyHash } : {}), uploadHash, operation: "install", connectionDefinitions: [...inspected.connections.values()] }
      await this.saveJournal(journal, "prepared", options.authorize)
      return previewOf(journal)
    })
  }

  stageSeed(id: string, options: PluginStageOptions): Promise<PluginInstallPreview> {
    const captured = { ...options, client: input(() => parseClientRuntimeDescriptor(options.client)), scope: input(() => scopeSchema.parse(options.scope)) }
    return this.mutate(async () => previewOf(await this.prepareSeed(id, captured)))
  }
  private async prepareSeed(id: string, options: PluginStageOptions, automatic = false): Promise<PluginJournal> {
    await this.authorize(options.authorize)
    if (!options.owner || options.owner.length > 1024) throw new PluginStoreError("FORBIDDEN", "Missing transaction owner")
    const seed = this.appSeeds.get(id)
    if (!seed) throw new PluginStoreError("NOT_FOUND", "Plugin is not in this app release's seed catalog")
    const { inspected } = seed
    const existing = this.registry.plugins[id]
    if (existing && gt(existing.manifest.version, inspected.manifest.version)) throw new PluginStoreError("NEWER_INSTALLED", "An app seed cannot replace a newer installed plugin")
    await this.pruneTransactions()
    const idempotencyHash = options.idempotencyKey ? sha256(JSON.stringify([options.owner, options.idempotencyKey])) : undefined
    const priorJournal = idempotencyHash && [...this.journals.values()].find(journal => journal.idempotencyHash === idempotencyHash)
    if (priorJournal) {
      if (!priorJournal.appSeed || priorJournal.digest !== inspected.digest || JSON.stringify(priorJournal.scope) !== JSON.stringify(options.scope)
        || JSON.stringify(priorJournal.client) !== JSON.stringify(options.client)) throw new PluginStoreError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another candidate")
      return priorJournal
    }
    this.checkState(inspected.manifest, inspected.digest, false, true)
    const retained = this.trust.appSeeds?.[inspected.digest]
    if (retained && (retained.pluginId !== id || retained.publisher !== inspected.manifest.publisher || retained.version !== inspected.manifest.version
      || retained.targetPath !== seed.provenance.targetPath)) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Retained app seed provenance conflicts with the release")
    const provenance = retained ?? seed.provenance
    const publisher = this.trust.publishers[provenance.publisher]
    if (publisher?.checkpoint) {
      const bundle = this.retainedBundle(provenance.publisher, provenance.targetPath, inspected.payload)
      const verification = await verifyOffline({ pinnedRoot: decodeBase64(publisher.pinnedRoot, 256 * 1024), checkpoint: decodeCheckpoint(publisher.checkpoint), bundle })
      const audited = await this.auditSelected(bundle, verification.checkpoint)
      await this.retainTrust(provenance.publisher, audited.checkpoint, audited.revoked, options.authorize)
      if (!verification.trusted || verification.target.hashes.sha256 !== inspected.digest) throw new PluginStoreError("UNTRUSTED_PACKAGE", "Retained publisher metadata does not authorize this app seed")
    }
    if (!retained) {
      const next = structuredClone(this.trust)
      next.appSeeds ??= {}
      next.appSeeds[inspected.digest] = provenance
      await this.write("trust.json", trustSchema.parse(next), "app-seed-trust", options.authorize)
      this.trust = next
    }
    await this.savePayload(inspected, options.authorize)
    await this.authorize(options.authorize)
    const journal: PluginJournal = {
      formatVersion: 1, minWriterVersion: 1, id: randomUUID(), ownerHash: sha256(options.owner), status: "prepared", createdAt: Date.now(),
      registryRevision: this.registry.revision, manifest: inspected.manifest, digest: inspected.digest, targetPath: provenance.targetPath,
      publisherKind: "official", oldVersion: existing?.manifest.version ?? null, scope: options.scope, client: options.client,
      compatibility: evaluateCompatibility(inspected.manifest, options.client, { ...this.options.host, registryRevision: this.registry.revision }),
      ...(idempotencyHash ? { idempotencyHash } : {}), uploadHash: inspected.digest, operation: "install", connectionDefinitions: [...inspected.connections.values()],
      appSeed: provenance, ...(automatic ? { automaticSeedMigration: true } : {}),
    }
    await this.saveJournal(journal, "prepared-seed", options.authorize)
    return journal
  }
  migrateLegacySeeds(options: { client: PluginStageOptions["client"]; authorize: PluginAuthorize }): Promise<{ snapshot: PluginStoreSnapshot; failures: { id: string; code: string; message: string }[] }> {
    const client = input(() => parseClientRuntimeDescriptor(options.client))
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      const classification = this.options.legacyHost?.classification === "indeterminate" ? this.options.legacyHost : this.registry.seedMigration?.classification
      if (!classification) throw new PluginStoreError("HOST_CLASSIFICATION_REQUIRED", "Host classification must be captured before first-run setup")
      if (classification.classification === "indeterminate") throw new PluginStoreError("HOST_CLASSIFICATION_UNKNOWN", "Existing host configuration needs inspection before optional plugin migration")
      const failures: { id: string; code: string; message: string }[] = []
      const legacyIds = new Set(Object.values(LEGACY_PLUGIN_ALIASES))
      for (const id of this.appSeeds.keys()) {
        if (this.registry.seedMigration!.decisions[id]) continue
        const previousIdentity = Object.keys(this.registry.identities).some(identity => identity.startsWith(`${id}@`))
        if (classification.classification === "fresh" || !legacyIds.has(id) || this.registry.plugins[id] || previousIdentity) {
          const next = structuredClone(this.registry)
          next.seedMigration!.decisions[id] = classification.classification === "fresh" || !legacyIds.has(id) ? "fresh" : "preserved"
          next.revision++
          await this.write("registry.json", registrySchema.parse(next), "seed-migration-skip", options.authorize)
          this.registry = next
          continue
        }
        let journal: PluginJournal | undefined
        try {
          journal = await this.prepareSeed(id, { owner: "app-seed-migration", client, scope: { type: "all" }, authorize: options.authorize }, true)
          await this.commitJournal(journal, { authorize: options.authorize, expectedRevision: journal.registryRevision }, true)
        } catch (error) {
          if (!(error instanceof PluginStoreError) || error.code === "FORBIDDEN") throw error
          if (journal?.status === "prepared") {
            journal.status = "cancelled"; journal.reason = "App seed migration failed validation"
            await this.saveJournal(journal, "cancelled-seed", options.authorize)
          }
          failures.push({ id, code: error.code, message: error.message })
        }
      }
      return { snapshot: this.snapshot(), failures }
    })
  }

  payload(digestOrTransaction: string, owner?: string): Promise<Buffer> {
    return this.mutate(async () => {
      const transaction = this.journals.get(digestOrTransaction)
      if (transaction) {
        const journal = this.journalFor(digestOrTransaction, owner ?? "")
        if (!["prepared", "trial"].includes(journal.status)) throw new PluginStoreError("TRANSACTION_FINISHED", "Transaction no longer provides provisional package bytes")
        const payload = await this.readPayload(journal.digest)
        this.delivered.add(journal.id)
        return payload
      }
      if (!Object.values(this.registry.plugins).some(plugin => plugin.versions.some(version => version.digest === digestOrTransaction))) throw new PluginStoreError("NOT_FOUND", "Package is not referenced by an installed plugin")
      return this.readPayload(digestOrTransaction)
    })
  }
  beginTrial(id: string, owner: string, options: { authorize: PluginAuthorize }): Promise<{ deadline: number }> {
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      const journal = this.journalFor(id, owner)
      this.checkRevision(journal.registryRevision)
      if (!journal.compatibility.compatible) throw new PluginStoreError("INCOMPATIBLE", "Candidate is incompatible with this host or client")
      if (!this.delivered.has(id)) throw new PluginStoreError("PAYLOAD_REQUIRED", "Fetch the candidate bytes before starting its readiness deadline")
      if (journal.status === "trial") return { deadline: journal.deadline! }
      if (journal.status !== "prepared") throw new PluginStoreError("TRANSACTION_FINISHED", "Transaction is not ready for a trial")
      journal.status = "trial"; journal.deadline = Date.now() + COORDINATION_DEADLINE_MS
      await this.authorize(options.authorize)
      await this.saveJournal(journal, "trial", options.authorize)
      return { deadline: journal.deadline }
    })
  }
  commit(id: string, owner: string, options: PluginMutationOptions): Promise<PluginStoreSnapshot> {
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      return this.commitJournal(this.journalFor(id, owner), options)
    })
  }
  private async commitJournal(journal: PluginJournal, options: PluginMutationOptions, automatic = false): Promise<PluginStoreSnapshot> {
    if (journal.status === "committed") return this.snapshot()
    this.checkRevision(options.expectedRevision)
    if (journal.registryRevision !== options.expectedRevision) throw new PluginStoreError("STALE_REVISION", "Candidate was reviewed against a different registry")
    if (automatic) {
      if (!journal.automaticSeedMigration || !journal.appSeed || journal.status !== "prepared") throw new PluginStoreError("INVALID_SEED_MIGRATION", "Automatic import requires an app-owned seed transaction")
    } else {
      if (journal.status !== "trial") throw new PluginStoreError("TRIAL_EXPIRED", "Candidate readiness trial is missing or expired")
      this.checkDeadline(journal)
    }
    this.checkState(journal.manifest, journal.digest, journal.operation === "rollback")
    const publisher = this.trust.publishers[journal.manifest.publisher]
    if (publisher?.checkpoint?.revokedTargets.includes(journal.targetPath)) throw new PluginStoreError("REVOKED", "Candidate was revoked after review")
    if (!evaluateCompatibility(journal.manifest, journal.client, { ...this.options.host, registryRevision: this.registry.revision }, { allowPrerelease: publisher?.kind === "development" }).compatible) throw new PluginStoreError("INCOMPATIBLE", "Candidate is no longer compatible")
    const candidatePayload = await this.readPayload(journal.digest)
    await this.reverifyCandidate(journal, candidatePayload, options.authorize)
    this.checkRevision(options.expectedRevision)
    const inspected = inspectPackage(candidatePayload, journal.manifest.publisher)
    if (JSON.stringify(inspected.manifest) !== JSON.stringify(journal.manifest)) throw new Error("Prepared package manifest changed")
    const previous = this.registry.plugins[journal.manifest.id]
    const next = structuredClone(this.registry)
    const versions = previous?.versions.filter(version => version.digest !== journal.digest) ?? []
    versions.push({ digest: journal.digest, manifest: journal.manifest, targetPath: journal.targetPath, installedAt: Date.now() })
    while (versions.length > MAX_RETAINED_VERSIONS) {
      const oldest = versions.findIndex(version => version.digest !== previous?.selectedDigest && version.digest !== journal.digest)
      if (oldest < 0) throw new PluginStoreError("QUOTA_EXCEEDED", "Plugin version retention limit reached")
      versions.splice(oldest, 1)
    }
    next.plugins[journal.manifest.id] = { id: journal.manifest.id, selectedDigest: journal.digest, manifest: journal.manifest, enabled: previous?.enabled ?? true, scope: journal.scope, pinned: previous?.pinned ?? false, versions }
    next.dataSchemas[journal.manifest.id] ??= [journal.manifest.stateVersion]
    next.identities[`${journal.manifest.id}@${journal.manifest.version}`] = journal.digest
    next.seedMigration ??= { decisions: {} }
    next.seedMigration.decisions[journal.manifest.id] = automatic ? "imported" : "preserved"
    next.revision++
    await this.options.beforeChange?.(journal.manifest.id, "commit")
    await this.authorize(options.authorize)
    journal.status = "committing"; journal.nextRegistry = next
    await this.saveJournal(journal, "commit-intent", options.authorize)
    await this.authorize(options.authorize)
    await this.write("registry.json", registrySchema.parse(next), "commit-registry", options.authorize, automatic ? undefined : () => this.checkDeadline(journal))
    this.registry = next
    journal.status = "committed"; delete journal.nextRegistry
    await this.saveJournal(journal, "committed")
    this.delivered.delete(journal.id)
    return this.snapshot()
  }
  cancel(id: string, owner: string, options: { authorize: PluginAuthorize }): Promise<void> {
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      const journal = this.journalFor(id, owner)
      if (journal.status === "committed") throw new PluginStoreError("TRANSACTION_FINISHED", "Committed packages cannot be cancelled")
      journal.status = "cancelled"; journal.reason = "Cancelled by the coordinating client"
      await this.authorize(options.authorize)
      await this.saveJournal(journal, "cancelled", options.authorize)
      this.delivered.delete(id)
      await this.collectPackages(journal.digest)
    })
  }
  private change(id: string, options: PluginMutationOptions, reason: string, update: (registry: PluginRegistry) => void): Promise<PluginStoreSnapshot> {
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      this.checkRevision(options.expectedRevision)
      if (!Object.hasOwn(this.registry.plugins, id)) throw new PluginStoreError("NOT_FOUND", "Plugin is not installed")
      const next = structuredClone(this.registry)
      update(next); next.revision++
      await this.options.beforeChange?.(id, reason)
      await this.authorize(options.authorize)
      await this.write("registry.json", registrySchema.parse(next), `${reason}-registry`, options.authorize)
      this.registry = next
      return this.snapshot()
    })
  }
  setEnabled(id: string, enabled: boolean, options: PluginMutationOptions): Promise<PluginStoreSnapshot> {
    return this.change(id, options, enabled ? "enable" : "disable", next => {
      const plugin = next.plugins[id]
      if (enabled && next.quarantined?.[plugin.selectedDigest]) throw new PluginStoreError("PACKAGE_UNAVAILABLE", "This package is quarantined; select another retained version")
      if (enabled && this.trust.publishers[plugin.manifest.publisher]?.checkpoint?.revokedTargets.includes(this.selectedVersion(plugin).targetPath)) throw new PluginStoreError("REVOKED", "Revoked packages cannot be enabled")
      plugin.enabled = enabled
    })
  }
  setScope(id: string, scope: PluginScope, options: PluginMutationOptions): Promise<PluginStoreSnapshot> {
    const parsed = input(() => scopeSchema.parse(scope))
    return this.change(id, options, "scope", next => { next.plugins[id].scope = parsed })
  }
  setPin(id: string, pinned: boolean, options: PluginMutationOptions): Promise<PluginStoreSnapshot> { return this.change(id, options, "pin", next => { next.plugins[id].pinned = pinned }) }
  uninstall(id: string, options: PluginMutationOptions & { deleteDataFor?: string }): Promise<PluginStoreSnapshot> {
    return this.change(id, options, "uninstall", next => {
      const plugin = next.plugins[id]
      if (options.deleteDataFor !== undefined) {
        next.pendingDataDeletions ??= []
        next.pendingDataDeletions.push({ id: randomUUID(), principalId: options.deleteDataFor, publisher: plugin.manifest.publisher, pluginId: id })
      }
      delete next.plugins[id]; next.seedMigration ??= { decisions: {} }; next.seedMigration.decisions[id] = "uninstalled"
    })
  }
  pendingDataDeletions(): PluginDataDeletion[] { return structuredClone(this.registry.pendingDataDeletions ?? []) }
  finishDataDeletion(id: string): Promise<void> {
    return this.mutate(async () => {
      const next = structuredClone(this.registry)
      next.pendingDataDeletions = next.pendingDataDeletions?.filter(deletion => deletion.id !== id)
      await this.write("registry.json", registrySchema.parse(next), "finish-data-deletion")
      this.registry = next
    })
  }
  rollback(id: string, digest: string, options: PluginStageOptions): Promise<PluginInstallPreview> {
    const scope = input(() => scopeSchema.parse(options.scope))
    const client = input(() => parseClientRuntimeDescriptor(options.client))
    return this.mutate(async () => {
      await this.authorize(options.authorize)
      if (!options.owner || options.owner.length > 1024) throw new PluginStoreError("FORBIDDEN", "Missing transaction owner")
      await this.pruneTransactions()
      const plugin = Object.hasOwn(this.registry.plugins, id) ? this.registry.plugins[id] : undefined
      const version = plugin?.versions.find(version => version.digest === digest)
      if (!version) throw new PluginStoreError("NOT_FOUND", "Rollback package is not retained")
      this.checkState(version.manifest, digest, true)
      const publisher = this.trust.publishers[version.manifest.publisher]
      if (publisher?.checkpoint?.revokedTargets.includes(version.targetPath)) throw new PluginStoreError("REVOKED", "Rollback package is revoked")
      const inspected = inspectPackage(await this.readPayload(digest), version.manifest.publisher)
      await this.authorize(options.authorize)
      const journal: PluginJournal = { formatVersion: 1, minWriterVersion: 1, id: randomUUID(), ownerHash: sha256(options.owner), status: "prepared", createdAt: Date.now(), registryRevision: this.registry.revision, manifest: version.manifest, digest, targetPath: version.targetPath, publisherKind: publisher?.kind ?? "official", oldVersion: plugin!.manifest.version, scope, client, compatibility: evaluateCompatibility(version.manifest, client, this.options.host, { allowPrerelease: publisher?.kind === "development" }), uploadHash: digest, operation: "rollback", connectionDefinitions: [...inspected.connections.values()] }
      const seed = this.seedProvenance(version.digest, version.manifest.id, version.targetPath)
      if (seed) journal.appSeed = seed
      await this.saveJournal(journal, "prepared-rollback", options.authorize)
      return previewOf(journal)
    })
  }
  transactionOutcome(id: string, owner: string): Promise<{ status: PluginJournal["status"]; preview: PluginInstallPreview; deadline?: number }> {
    return this.mutate(async () => {
      const journal = this.journalFor(id, owner)
      return { status: journal.status, preview: previewOf(journal), ...(journal.deadline === undefined ? {} : { deadline: journal.deadline }) }
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue
    this.available = false
    await this.lock?.release().catch(() => undefined)
    this.lock = undefined
  }
}
export const openPluginStore = (root: string, options: PluginStoreOptions): Promise<PluginStore> => PluginStore.open(root, options)
