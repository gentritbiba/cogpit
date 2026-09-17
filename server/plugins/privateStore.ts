import { lstat, readdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { acquirePluginStoreLock, type PluginStoreLock } from "./lock"
import { documentBytes, durableWrite, ensureDirectory, exists, isWriteTemporary, regularFile, removeDurably, STORE_DOCUMENT_LIMIT } from "./durable"
import { parseJsonText } from "./json"

export class PluginDataError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PluginDataError" }
}
export type DataGuard = () => void | Promise<void>
type Document = { formatVersion: number; minWriterVersion: number; revision: number }
export class PrivatePluginStore<T extends Document> {
  private lock?: PluginStoreLock
  private available = false
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private constructor(private root: string, private readonly filename: string, private value: T, private readonly schema: z.ZodType<T>, private readonly compromised: () => void, private readonly hook?: (step: string) => void | Promise<void>) {}

  static async open<T extends Document>(root: string, filename: string, initial: T, schema: z.ZodType<T>, compromised: () => void, hook?: (step: string) => void | Promise<void>): Promise<PrivatePluginStore<T>> {
    const store = new PrivatePluginStore(resolve(root), filename, initial, schema, compromised, hook)
    try {
      await ensureDirectory(store.root)
      store.root = await realpath(store.root)
      if (process.platform !== "win32" && (await lstat(store.root)).mode & 0o077) throw new Error("Private directory permissions")
      const hadOwner = await exists(join(store.root, "owner.json"))
      store.lock = await acquirePluginStoreLock(store.root, () => store.fail())
      const names = await readdir(store.root)
      if (names.some(name => ![filename, "initialized.json", "owner.json", ".store.lock"].includes(name) && !isWriteTemporary(name))) throw new Error("Unknown document")
      const markerPath = join(store.root, "initialized.json")
      const initialized = await exists(markerPath)
      const markerSchema = z.strictObject({ formatVersion: z.literal(1), minWriterVersion: z.literal(1), document: z.literal(filename) })
      if (initialized) {
        if (process.platform !== "win32" && (await lstat(markerPath)).mode & 0o077) throw new Error("Private marker permissions")
        markerSchema.parse(parseJsonText(await regularFile(markerPath), 4096))
      }
      const initialize = () => durableWrite(markerPath, documentBytes({ formatVersion: 1, minWriterVersion: 1, document: filename }), { label: "initialize-marker", guard: () => store.lock!.assertOwned() })
      if (await exists(join(store.root, filename))) {
        if (process.platform !== "win32" && (await lstat(join(store.root, filename))).mode & 0o077) throw new Error("Private file permissions")
        store.value = schema.parse(parseJsonText(await regularFile(join(store.root, filename)), STORE_DOCUMENT_LIMIT))
        if (!initialized) await initialize()
      }
      else {
        if (initialized || hadOwner || names.some(name => !["owner.json", ".store.lock"].includes(name) && !isWriteTemporary(name))) throw new Error("Missing document")
        await initialize()
        await durableWrite(join(store.root, filename), documentBytes(initial), { label: "initialize-private", guard: () => store.lock!.assertOwned() })
      }
      for (const name of names.filter(isWriteTemporary)) { await regularFile(join(store.root, name)); await store.lock.assertOwned(); await removeDurably(join(store.root, name)) }
      store.available = true
      return store
    } catch {
      await store.lock?.release().catch(() => undefined)
      throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin private storage is unavailable; retained files require inspection")
    }
  }
  private fail(): void { this.available = false; this.compromised() }
  private assertAvailable(): void { if (!this.available || this.closed) throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin private storage is unavailable") }
  read(): T { this.assertAvailable(); return structuredClone(this.value) }
  drain(): Promise<void> { return this.queue }
  update(expectedRevision: number | undefined, guard: DataGuard, change: (next: T) => void, beforeChange?: () => void): Promise<T> {
    const result = this.queue.then(async () => {
      this.assertAvailable()
      const capturedRevision = expectedRevision ?? this.value.revision
      try {
        const check = async () => {
          await this.lock!.assertOwned()
          await guard()
          this.assertAvailable()
          if (this.value.revision !== capturedRevision) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data changed; refresh and retry")
        }
        await check()
        const next = this.read()
        change(next)
        next.revision++
        if (Buffer.byteLength(JSON.stringify(next)) > STORE_DOCUMENT_LIMIT) throw new PluginDataError("RATE_LIMITED", "Plugin saved data quota is full")
        const document = this.schema.parse(next)
        let bytes: Buffer
        try { bytes = documentBytes(document) } catch { throw new PluginDataError("RATE_LIMITED", "Plugin saved data exceeds its JSON limits") }
        beforeChange?.()
        await durableWrite(join(this.root, this.filename), bytes, { label: "private", guard: check, hook: this.hook })
        this.value = next
        return this.read()
      } catch (error) {
        if (error instanceof PluginDataError || error && typeof error === "object" && "code" in error && ["STALE_ACTIVATION", "PERMISSION_REQUIRED", "CANCELED"].includes(String(error.code))) throw error
        this.fail()
        throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin private storage is unavailable")
      }
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  async close(): Promise<void> { this.closed = true; await this.queue; this.available = false; await this.lock?.release().catch(() => undefined) }
}
