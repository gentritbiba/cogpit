import { createHash } from "node:crypto"
import { z } from "zod"
import { PrivatePluginStore, PluginDataError, type DataGuard } from "./privateStore"

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.strictObject({ principalId: z.string().min(1).max(256), publisher: z.string().min(1).max(64), pluginId: z.string().min(1).max(128) })
export type PluginDataNamespace = z.infer<typeof identity>
const selection = z.strictObject({ id: z.string().min(1).max(1024), label: z.string().min(1).max(256) })
export type SavedResourceSelection = z.infer<typeof selection>
const selections = z.record(z.string().max(128), selection)
const record = identity.extend({ connectionId: z.string().min(1).max(128), definitionHash: z.string().regex(/^[a-f0-9]{64}$/), secret: z.string().regex(/^[\x21-\x7e]{1,4096}$/).optional(), identity: z.record(z.string().max(128), z.string().max(1024)), selected: selections, projects: z.record(z.string().max(64), selections) })
export type SavedPluginConnection = z.infer<typeof record>
const legacySchema = z.strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/), backup: z.string().min(1).max(512), preparedAt: integer, token: z.string().regex(/^[\x21-\x7e]{1,4096}$/).optional(), projects: z.record(z.string().max(4096), z.string().regex(/^\d{1,128}$/)), principalId: z.string().min(1).max(256).nullable(), automatic: z.boolean(), automaticFailed: z.boolean().default(false), credentialImported: z.boolean(), environmentPrepared: z.boolean().default(false), importedProjects: z.array(z.string().max(4096)).max(1024), decidedProjects: z.array(z.string().max(64)).max(1024).default([]), suppressed: z.boolean() })
export type LegacyClickUpImport = z.infer<typeof legacySchema>
export interface LegacyImportProgress { hash: string; principalId: string; projectPath?: string; projectId?: string; credentialImported: boolean; environmentPrepared: boolean }
const schema = z.strictObject({ formatVersion: z.literal(1), minWriterVersion: z.literal(1), revision: integer, connections: z.record(z.string().regex(/^[a-f0-9]{64}$/), record), clearing: z.array(identity).max(1024), legacyClickUp: legacySchema.optional() })
const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
export const namespaceKey = (scope: PluginDataNamespace): string => hash([scope.principalId, scope.publisher, scope.pluginId])
const connectionKey = (scope: PluginDataNamespace, id: string, definitionHash: string) => hash([scope.principalId, scope.publisher, scope.pluginId, id, definitionHash])
const same = (a: PluginDataNamespace, b: PluginDataNamespace) => namespaceKey(a) === namespaceKey(b)
export class PluginConnectionStore {
  private mutations = 0
  private constructor(private readonly store: PrivatePluginStore<z.infer<typeof schema>>, private readonly revoke: () => void) {}
  static async open(root: string, revoke: () => void, hook?: (step: string) => void | Promise<void>, compromised = revoke): Promise<PluginConnectionStore> {
    const store = await PrivatePluginStore.open(root, "connections.json", { formatVersion: 1, minWriterVersion: 1, revision: 0, connections: {}, clearing: [] }, schema, compromised, hook)
    const value = store.read()
    for (const [key, connection] of Object.entries(value.connections)) {
      if (key !== connectionKey(connection, connection.connectionId, connection.definitionHash)) { await store.close(); throw new PluginDataError("CAPABILITY_UNAVAILABLE", "Plugin connection storage is inconsistent") }
    }
    return new PluginConnectionStore(store, revoke)
  }
  get revision(): number { return this.store.read().revision }
  get changing(): boolean { return this.mutations > 0 || this.store.read().clearing.length > 0 }
  drain(): Promise<void> { return this.store.drain() }
  private async changingData(operation: () => Promise<void>): Promise<void> { this.mutations++; try { await operation() } finally { this.mutations-- } }
  get(scope: PluginDataNamespace, connectionId: string, definitionHash: string): SavedPluginConnection | undefined {
    const document = this.store.read()
    if (document.clearing.some(value => same(value, scope))) throw new PluginDataError("STALE_ACTIVATION", "Plugin saved data is being cleared")
    return document.connections[connectionKey(scope, connectionId, definitionHash)]
  }
  async set(scope: PluginDataNamespace, connectionId: string, value: Omit<SavedPluginConnection, keyof PluginDataNamespace | "connectionId">, revision: number, guard: DataGuard, legacy?: LegacyImportProgress, decidedProject?: string): Promise<void> {
    await this.changingData(async () => { await this.store.update(revision, guard, next => {
      if (Object.keys(next.connections).length >= 4096 && !next.connections[connectionKey(scope, connectionId, value.definitionHash)]) throw new PluginDataError("RATE_LIMITED", "Plugin connection limit reached")
      next.connections[connectionKey(scope, connectionId, value.definitionHash)] = record.parse({ ...scope, connectionId, ...value })
      if (decidedProject && next.legacyClickUp?.principalId === scope.principalId && scope.pluginId === "cogpit.clickup" && connectionId === "clickup" && !next.legacyClickUp.decidedProjects.includes(decidedProject)) next.legacyClickUp.decidedProjects.push(decidedProject)
      if (legacy) {
        const source = next.legacyClickUp
        if (!source || source.hash !== legacy.hash || source.principalId && source.principalId !== legacy.principalId) throw new PluginDataError("STALE_ACTIVATION", "Legacy import changed")
        source.principalId = legacy.principalId; source.credentialImported ||= legacy.credentialImported; source.environmentPrepared ||= legacy.environmentPrepared
        source.automaticFailed = false
        if (legacy.projectPath && !source.importedProjects.includes(legacy.projectPath)) source.importedProjects.push(legacy.projectPath)
        if (legacy.projectId && !source.decidedProjects.includes(legacy.projectId)) source.decidedProjects.push(legacy.projectId)
      }
    }, this.revoke) })
  }
  legacy(): LegacyClickUpImport | undefined { return this.store.read().legacyClickUp }
  async prepareLegacy(value: LegacyClickUpImport, revision: number, guard: DataGuard): Promise<void> { await this.changingData(async () => { await this.store.update(revision, guard, next => { next.legacyClickUp = legacySchema.parse(value) }, this.revoke) }) }
  async pauseLegacy(hash: string, revision: number, guard: DataGuard): Promise<void> {
    await this.changingData(async () => { await this.store.update(revision, guard, next => {
      if (next.legacyClickUp?.hash !== hash) throw new PluginDataError("STALE_ACTIVATION", "Legacy import changed")
      next.legacyClickUp.automatic = false; next.legacyClickUp.automaticFailed = true
    }, this.revoke) })
  }
  async disconnect(scope: PluginDataNamespace, connectionId: string, revision: number, guard: DataGuard): Promise<void> { await this.changingData(async () => { await this.store.update(revision, guard, next => {
    for (const [key, record] of Object.entries(next.connections)) if (same(record, scope) && record.connectionId === connectionId) delete next.connections[key]
    if (scope.pluginId === "cogpit.clickup" && connectionId === "clickup" && next.legacyClickUp?.principalId === scope.principalId) { next.legacyClickUp.suppressed = true; delete next.legacyClickUp.token }
  }, this.revoke) }) }
  pendingClears(): PluginDataNamespace[] { return this.store.read().clearing }
  async beginClear(scope: PluginDataNamespace, revision: number | undefined, guard: DataGuard): Promise<void> {
    await this.changingData(async () => { await this.store.update(revision, guard, next => {
      for (const [key, record] of Object.entries(next.connections)) if (same(record, scope)) delete next.connections[key]
      if (scope.pluginId === "cogpit.clickup" && next.legacyClickUp?.principalId === scope.principalId) {
        next.legacyClickUp.suppressed = true; delete next.legacyClickUp.token
        next.legacyClickUp.projects = {}; next.legacyClickUp.importedProjects = []; next.legacyClickUp.decidedProjects = []
      }
      if (!next.clearing.some(value => same(value, scope))) next.clearing.push(scope)
    }, this.revoke) })
  }
  async finishClear(scope: PluginDataNamespace): Promise<void> { await this.store.update(undefined, () => {}, next => { next.clearing = next.clearing.filter(value => !same(value, scope)) }) }
  close(): Promise<void> { return this.store.close() }
}
