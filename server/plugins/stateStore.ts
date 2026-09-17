import { createHash } from "node:crypto"
import { z } from "zod"
import { CONTRACT_LIMITS, parseJson, type JsonValue } from "@cogpit/plugin-contracts"
import { namespaceKey, type PluginDataNamespace } from "./connectionStore"
import { PrivatePluginStore, PluginDataError, type DataGuard } from "./privateStore"

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const namespace = z.strictObject({ principalId: z.string().min(1).max(256), publisher: z.string().min(1).max(64), pluginId: z.string().min(1).max(128), projectKey: z.string().max(64).nullable(), stateVersion: integer.min(1), revision: integer, values: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/), z.unknown()) })
const schema = z.strictObject({ formatVersion: z.literal(1), minWriterVersion: z.literal(1), revision: integer, namespaces: z.record(z.string().regex(/^[a-f0-9]{64}$/), namespace) })
export interface PluginStateNamespace extends PluginDataNamespace { projectKey: string | null; stateVersion: number; quotaKiB: number }
const keyFor = (scope: Pick<PluginStateNamespace, "principalId" | "publisher" | "pluginId" | "projectKey">) => createHash("sha256").update(JSON.stringify([namespaceKey(scope), scope.projectKey])).digest("hex")
export class PluginStateStore {
  private constructor(private readonly store: PrivatePluginStore<z.infer<typeof schema>>) {}
  static async open(root: string, compromised: () => void, hook?: (step: string) => void | Promise<void>): Promise<PluginStateStore> {
    const store = await PrivatePluginStore.open(root, "state.json", { formatVersion: 1, minWriterVersion: 1, revision: 0, namespaces: {} }, schema, compromised, hook)
    try {
      for (const [key, state] of Object.entries(store.read().namespaces)) {
        if (key !== keyFor(state)) throw new Error("Invalid state namespace")
        for (const value of Object.values(state.values)) parseJson(value, { maxBytes: CONTRACT_LIMITS.storageValueBytes })
      }
    } catch { await store.close(); throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin state storage is inconsistent") }
    return new PluginStateStore(store)
  }
  get(scope: PluginStateNamespace, key: string): JsonValue {
    const state = this.store.read().namespaces[keyFor(scope)]
    if (state && state.stateVersion !== scope.stateVersion) throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin saved state schema is incompatible")
    return state && Object.hasOwn(state.values, key) ? parseJson(state.values[key], { maxBytes: CONTRACT_LIMITS.storageValueBytes }) : null
  }
  drain(): Promise<void> { return this.store.drain() }
  async write(scope: PluginStateNamespace, key: string, value: JsonValue | undefined, guard: DataGuard): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new PluginDataError("INVALID_REQUEST", "Invalid plugin storage key")
    let parsed: JsonValue | undefined
    try { parsed = value === undefined ? undefined : parseJson(value, { maxBytes: CONTRACT_LIMITS.storageValueBytes }) } catch { throw new PluginDataError("INVALID_REQUEST", "Plugin state value exceeds its limit") }
    const document = this.store.read()
    const argumentsKey = key
    await this.store.update(document.revision, guard, next => {
      const key = keyFor(scope)
      const existing = next.namespaces[key]
      if (existing && existing.stateVersion !== scope.stateVersion) throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin saved state schema is incompatible")
      const state = existing ?? { principalId: scope.principalId, publisher: scope.publisher, pluginId: scope.pluginId, projectKey: scope.projectKey, stateVersion: scope.stateVersion, revision: 0, values: {} }
      if (parsed === undefined) delete state.values[argumentsKey]
      else state.values[argumentsKey] = parsed
      if (Buffer.byteLength(JSON.stringify(state.values)) > scope.quotaKiB * 1024) throw new PluginDataError("RATE_LIMITED", "Plugin saved state quota is full")
      state.revision++
      next.namespaces[key] = state
    })
  }
  async clear(scope: PluginDataNamespace): Promise<void> {
    await this.store.update(undefined, () => {}, next => { for (const [key, value] of Object.entries(next.namespaces)) if (namespaceKey(value) === namespaceKey(scope)) delete next.namespaces[key] })
  }
  close(): Promise<void> { return this.store.close() }
}
