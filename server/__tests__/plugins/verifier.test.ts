// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { MetadataKind } from "@tufjs/models"
import { verifyOffline, type OfflinePluginBundle, type PluginTrustCheckpoint } from "../../plugins/verifier"
import { createAuthority, createRoot, createBundle, mutate, payload, replaceTargets, resign, sha256, targetPath, type Authority } from "./fixtures/signing"

let authority: Authority
let pinnedRoot: Buffer
let bundle: OfflinePluginBundle
const verify = (candidate = bundle, checkpoint?: PluginTrustCheckpoint) => verifyOffline({ pinnedRoot, bundle: candidate, checkpoint })
const version = (checkpoint: PluginTrustCheckpoint, name: string) => JSON.parse(checkpoint.metadata.get(name)!.toString("utf8")).signed.version

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"))
  authority = createAuthority()
  pinnedRoot = createRoot(authority)
  bundle = createBundle(authority)
})
afterEach(() => vi.useRealTimers())

describe("offline plugin verification", () => {
  it("authenticates payload bytes and accepts the identical current bundle", async () => {
    const first = await verify()
    expect(first.trusted).toBe(true)
    if (!first.trusted) throw new Error(first.reason)
    expect(first.target).toMatchObject({ path: targetPath, length: payload.length, hashes: { sha256: sha256(payload) } })
    expect(first.checkpoint.verifiedTargets.get(targetPath)).toEqual(first.target)
    expect((await verify(bundle, first.checkpoint)).trusted).toBe(true)
  })

  it.each(["timestamp", "snapshot", "targets", "publisher"] as const)("rejects expired %s metadata", async role => {
    const result = await verify(createBundle(authority, { expiredRole: role, delegated: role === "publisher" }))
    expect(result).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("expired") })
  })

  it("rejects an expired final root", async () => {
    pinnedRoot = createRoot(authority, { expired: true })
    expect(await verify()).toMatchObject({ trusted: false, reason: expect.stringContaining("root.json is expired") })
  })

  it.each(["signature", "signed value"])("rejects a tampered timestamp %s", async kind => {
    const changed = mutate(bundle, "timestamp.json", value => {
      if (kind === "signature") value.signatures[0].sig = "00".repeat(64)
      else value.signed.version += 1
    })
    expect(await verify(changed)).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("signed by 0/1") })
  })

  it.each(["1.snapshot.json", "1.targets.json"])("verifies the parent hash link of %s", async name => {
    const changed = mutate(bundle, name, value => { value.signatures[0].sig = "00".repeat(64) })
    expect(await verify(changed)).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("Expected hash") })
  })

  it("checks target-role signatures even when the parent hashes are valid", async () => {
    const altered = replaceTargets(bundle, authority, value => { value.signatures[0].sig = "00".repeat(64) }, false)
    expect(await verify(altered)).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("signed by 0/1") })
  })

  it.each(["digest", "length"])("requires a signed target with a valid %s", async kind => {
    const altered = replaceTargets(bundle, authority, value => {
      if (kind === "digest") value.signed.targets[targetPath].hashes = {}
      else value.signed.targets[targetPath].length = Number.MAX_SAFE_INTEGER + 1
    })
    expect(await verify(altered)).toMatchObject({ trusted: false, code: "metadata-rejected", reason: "Target requires a SHA-256 digest and integer length" })
  })

  it("checks payload SHA-256 and length while preserving authenticated metadata", async () => {
    const tampered = Buffer.from(payload); tampered[0] ^= 1
    for (const bytes of [tampered, payload.subarray(1)]) {
      const result = await verify({ ...bundle, payload: bytes })
      expect(result).toMatchObject({ trusted: false, code: "payload-rejected" })
      expect(version(result.checkpoint, "timestamp.json")).toBe(1)
      expect(result.checkpoint.verifiedTargets.get(targetPath)?.hashes.sha256).toBe(sha256(payload))
    }
  })

  it("retains a newer verified timestamp when a later snapshot fails", async () => {
    const original = await verify()
    const newer = createBundle(authority, { version: 2 })
    const broken = mutate(newer, "2.snapshot.json", value => { value.signatures[0].sig = "00".repeat(64) })
    vi.setSystemTime(new Date("2026-09-14T13:00:00.000Z"))
    const failed = await verify(broken, original.checkpoint)
    expect(failed).toMatchObject({ trusted: false, code: "metadata-rejected" })
    expect(version(failed.checkpoint, "timestamp.json")).toBe(2)
    expect(version(failed.checkpoint, "snapshot.json")).toBe(1)
    expect(failed.checkpoint.verifiedAt).toBe(Date.now())
    expect(failed.checkpoint.revokedTargets.size).toBe(0)
    expect(version(original.checkpoint, "timestamp.json")).toBe(1)
    expect(await verify(bundle, failed.checkpoint)).toMatchObject({ trusted: false, reason: expect.stringContaining("rollback") })
    expect((await verify(newer, failed.checkpoint)).trusted).toBe(true)
  })

  it("retains verified snapshot advancement when targets verification fails", async () => {
    const prior = await verify()
    const newer = createBundle(authority, { version: 2 })
    const failed = await verify(mutate(newer, "2.targets.json", value => { value.signatures[0].sig = "00".repeat(64) }), prior.checkpoint)
    expect(failed.trusted).toBe(false)
    expect(version(failed.checkpoint, "snapshot.json")).toBe(2)
    expect(version(failed.checkpoint, "targets.json")).toBe(1)
    expect(failed.checkpoint.revokedTargets.size).toBe(0)
    expect((await verify(newer, failed.checkpoint)).trusted).toBe(true)
  })

  it("retains a verified rotated root even when the new timestamp fails", async () => {
    const prior = await verify()
    const nextAuthority = createAuthority()
    const nextRoot = createRoot(nextAuthority, { version: 2, previous: authority })
    const newer = createBundle(nextAuthority, { version: 2, roots: [nextRoot] })
    const failed = await verify(mutate(newer, "timestamp.json", value => { value.signatures[0].sig = "00".repeat(64) }), prior.checkpoint)
    expect(failed.trusted).toBe(false)
    expect(version(failed.checkpoint, "root.json")).toBe(2)
    expect(version(failed.checkpoint, "timestamp.json")).toBe(1)
    expect((await verify({ ...newer, roots: [] }, failed.checkpoint)).trusted).toBe(true)
    expect((await verify(createBundle(authority, { version: 2 }), failed.checkpoint)).trusted).toBe(false)
  })

  it("never decreases retained metadata versions after key rotation", async () => {
    const prior = await verify(createBundle(authority, { version: 3 }))
    const nextAuthority = createAuthority()
    const roots = [createRoot(nextAuthority, { version: 2, previous: authority })]
    expect(await verify(createBundle(nextAuthority, { version: 2, roots }), prior.checkpoint)).toMatchObject({ trusted: false, reason: expect.stringContaining("rollback") })
  })

  it("rejects changed metadata at the same version, including cache substitution", async () => {
    const prior = await verify()
    const changed = { ...bundle, metadata: new Map(bundle.metadata) }
    changed.metadata.set("1.snapshot.json", resign(bundle.metadata.get("1.snapshot.json")!, MetadataKind.Snapshot, value => { value.signed.expires = "2026-09-16T00:00:00.000Z" }, [authority.snapshot.signer]))
    expect(await verify(changed, prior.checkpoint)).toMatchObject({ trusted: false, reason: expect.stringContaining("without a version increase") })
  })

  it("checks a new timestamp's hash link even when its snapshot is already verified", async () => {
    const prior = await verify()
    const changed = { ...bundle, metadata: new Map(bundle.metadata) }
    changed.metadata.set("timestamp.json", resign(bundle.metadata.get("timestamp.json")!, MetadataKind.Timestamp, value => {
      value.signed.version = 2
      value.signed.meta["snapshot.json"].hashes.sha256 = "00".repeat(32)
    }, [authority.timestamp.signer]))
    const result = await verify(changed, prior.checkpoint)
    expect(result).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("Expected hash") })
    expect(version(result.checkpoint, "timestamp.json")).toBe(2)
    expect(result.checkpoint.revokedTargets.size).toBe(0)
  })

  it.each(["timestamp.json", "1.snapshot.json", "1.targets.json"])("requires uploaded %s even when a verified cache exists", async name => {
    const prior = await verify()
    const missing = { ...bundle, metadata: new Map(bundle.metadata) }; missing.metadata.delete(name)
    expect(await verify(missing, prior.checkpoint)).toMatchObject({ trusted: false, code: "invalid-bundle", reason: expect.stringContaining("Missing offline") })
  })

  it("rejects replay after serializing and restoring a trusted checkpoint", async () => {
    const current = await verify(createBundle(authority, { version: 2 }))
    const json = JSON.stringify({ verifiedAt: current.checkpoint.verifiedAt, metadata: [...current.checkpoint.metadata].map(([name, bytes]) => [name, bytes.toString("base64")]) })
    const restored: { verifiedAt: number; metadata: [string, string][] } = JSON.parse(json)
    expect(await verify(bundle, { verifiedAt: restored.verifiedAt, metadata: new Map(restored.metadata.map(([name, bytes]) => [name, Buffer.from(bytes, "base64")])) })).toMatchObject({ trusted: false, reason: expect.stringContaining("rollback") })
  })

  it.each(["snapshot", "targets"])("rejects rollback of %s beneath a newer timestamp", async role => {
    const prior = await verify(createBundle(authority, { version: 2 }))
    const newer = createBundle(authority, { version: 3, ...(role === "snapshot" ? { snapshotVersion: 1 } : { targetsVersion: 1 }) })
    expect(await verify(newer, prior.checkpoint)).toMatchObject({ trusted: false, reason: expect.stringContaining("rollback") })
  })

  it("rejects clock rollback without changing prior state", async () => {
    const prior = await verify()
    vi.setSystemTime(new Date("2026-09-14T11:59:00.000Z"))
    const result = await verify(bundle, prior.checkpoint)
    expect(result).toMatchObject({ trusted: false, code: "clock-rollback" })
    expect(result.checkpoint).toEqual(prior.checkpoint)
  })

  it("retains target revocation and refuses later reintroduction of the same exact path", async () => {
    const original = await verify()
    const removed = await verify(createBundle(authority, { version: 2, revoked: true }), original.checkpoint)
    expect(removed).toMatchObject({ trusted: false, code: "target-missing" })
    expect(removed.checkpoint.revokedTargets.has(targetPath)).toBe(true)
    expect(await verify(createBundle(authority, { version: 3 }), removed.checkpoint)).toMatchObject({ trusted: false, code: "target-revoked" })
  })

  it("does not revoke an unknown target merely because its path is absent", async () => {
    const result = await verify({ ...bundle, targetPath: "unknown/plugin/payload.json" })
    expect(result).toMatchObject({ trusted: false, code: "target-missing" })
    expect(result.checkpoint.revokedTargets.size).toBe(0)
  })

  it("refuses different bytes for a previously verified target path", async () => {
    const original = await verify()
    const changed = await verify(createBundle(authority, { version: 2, payload: Buffer.from("replacement") }), original.checkpoint)
    expect(changed).toMatchObject({ trusted: false, code: "target-changed" })
    expect(changed.checkpoint.verifiedTargets.get(targetPath)?.hashes.sha256).toBe(sha256(payload))
    expect(version(changed.checkpoint, "timestamp.json")).toBe(2)
  })

  it("rotates roots only with both previous and new root authorization", async () => {
    const nextAuthority = createAuthority()
    const roots = [createRoot(nextAuthority, { version: 2, previous: authority })]
    const rotated = createBundle(nextAuthority, { roots })
    expect((await verify(rotated)).trusted).toBe(true)
    expect((await verify({ ...rotated, roots: [createRoot(nextAuthority, { version: 2 })] })).trusted).toBe(false)
    const oldOnly = resign(roots[0], MetadataKind.Root, () => {}, [authority.root.signer])
    expect((await verify({ ...rotated, roots: [oldOnly] })).trusted).toBe(false)
    expect(await verify({ ...rotated, roots: [createRoot(nextAuthority, { version: 3, previous: authority })] })).toMatchObject({ trusted: false, reason: expect.stringContaining("not contiguous") })
  })

  it("resolves authorized delegations and preserves a target on incomplete delegation refresh", async () => {
    const delegated = createBundle(authority, { delegated: true })
    const prior = await verify(delegated)
    expect(prior.trusted).toBe(true)
    const newer = createBundle(authority, { version: 2, delegated: true })
    newer.metadata.delete("2.publisher.json")
    const result = await verify(newer, prior.checkpoint)
    expect(result).toMatchObject({ trusted: false, code: "metadata-rejected", reason: expect.stringContaining("Missing offline metadata") })
    expect(result.checkpoint.revokedTargets.size).toBe(0)
    expect(version(result.checkpoint, "timestamp.json")).toBe(2)
  })

  it.each(["../outside", "root", "constructor", "toString", "hasOwnProperty"])("rejects unsafe delegated role %s before any cache lookup", async name => {
    const delegated = createBundle(authority, { delegated: true })
    const unsafe = mutate(delegated, "1.targets.json", value => { value.signed.delegations.roles[0].name = name })
    expect(await verify(unsafe)).toMatchObject({ trusted: false, code: "invalid-bundle", reason: "Invalid delegated role name" })
  })

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("rejects inherited object name %s as a target path", async targetPath => {
    expect(await verify({ ...bundle, targetPath })).toMatchObject({ trusted: false, code: "invalid-bundle", reason: "Invalid target path" })
  })

  it("rejects an unrelated trust namespace", async () => {
    expect(await verify(createBundle(createAuthority()))).toMatchObject({ trusted: false, reason: expect.stringContaining("signed by 0/1") })
  })

  it("enforces bundle, metadata and target path bounds", async () => {
    expect(await verify({ ...bundle, payload: Buffer.alloc(4 * 1024 * 1024) })).toMatchObject({ trusted: false, reason: "Bundle exceeds byte limit" })
    const huge = { ...bundle, metadata: new Map(bundle.metadata).set("timestamp.json", Buffer.alloc(256 * 1024 + 1)) }
    expect(await verify(huge)).toMatchObject({ trusted: false, reason: "Metadata exceeds byte limit" })
    expect(await verify({ ...bundle, targetPath: "../escape" })).toMatchObject({ trusted: false, reason: "Invalid target path" })
  })

  it("rejects duplicate keys in an enrolled root before verification", async () => {
    pinnedRoot = Buffer.from(pinnedRoot.toString("utf8").replace('"version":1', '"version":1,"version":1'))
    expect(await verify()).toMatchObject({ trusted: false, code: "invalid-bundle", reason: "Duplicate JSON key: version" })
  })

  it("rejects malformed UTF-8 in a metadata document", async () => {
    const metadata = new Map(bundle.metadata).set("timestamp.json", Buffer.from([0xff, 0xfe]))
    expect(await verify({ ...bundle, metadata })).toMatchObject({ trusted: false, code: "invalid-bundle" })
  })

  it.each(["bad-date", "2026-99-99T00:00:00Z", "2026-02-30T00:00:00Z"])("rejects invalid metadata expiry %s", async expires => {
    expect(await verify(mutate(bundle, "timestamp.json", value => { value.signed.expires = expires }))).toMatchObject({ trusted: false, reason: "Invalid metadata expiry" })
  })
})
