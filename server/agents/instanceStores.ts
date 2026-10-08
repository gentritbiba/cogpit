import { orchestrationStore } from "../orchestration/storage"
import { createAcpStore } from "./acpStore"
import { join } from "node:path"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { instanceDirName, instanceSessionId, splitInstanceDirName, splitInstanceSessionId } from "../../shared/session/instances"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import { createClaudeStore } from "./claudeStore"
import { createCodexStore } from "./codexStore"
import { createCopilotStore } from "./copilotStore"
import type { AgentStore, SessionIdentity, SessionMeta } from "./types"

const factories = { acp: createAcpStore, claude: (home: string) => createClaudeStore(join(home, "projects")), codex: createCodexStore, copilot: createCopilotStore }
const cache = new Map<string, AgentStore>()
export function createInstanceStore(instance: ProviderInstance): AgentStore {
  const store = factories[instance.agent](instance.homeDir)
  const qualify = (id: string) => instanceSessionId(instance.id, id)
  const dir = (name: string) => instanceDirName(instance.id, name)
  const identity = <T extends SessionIdentity | SessionMeta>(value: T): T => ({ ...value, sessionId: qualify(value.sessionId), parentSessionId: value.parentSessionId ? qualify(value.parentSessionId) : null, ...("branchedFrom" in value && value.branchedFrom ? { branchedFrom: { ...value.branchedFrom, sessionId: qualify(value.branchedFrom.sessionId) } } : {}) })
  return {
    ...store, instanceId: instance.id, descriptor: { ...descriptorFor(instance.agent), sessionFile: { ...store.descriptor.sessionFile, sessionId: (file) => { const id = store.descriptor.sessionFile.sessionId(file); return id ? qualify(id) : null } } },
    async listSessionFiles() { return (await store.listSessionFiles()).map((file) => ({ ...file, dirName: file.dirName ? dir(file.dirName) : null })) },
    resolveSessionFile: (name, file) => store.resolveSessionFile(splitInstanceDirName(name).nativeDirName, file),
    findSessionFile: (id) => { const parts = splitInstanceSessionId(id); return parts.instanceId === instance.id ? store.findSessionFile(parts.nativeId) : Promise.resolve(null) },
    async transcriptRoot(path) { const root = await store.transcriptRoot(path); return root ? { ...root, rootSessionId: qualify(root.rootSessionId) } : null },
    async readIdentity(path) { const value = await store.readIdentity(path); return value ? identity(value) : null },
    async readSessionMeta(path, head) { return identity(await store.readSessionMeta(path, head)) },
    async listProjects() { return (await store.listProjects()).map((project) => ({ ...project, dirName: dir(project.dirName) })) },
    async listProjectSessionFiles(name) { const files = await store.listProjectSessionFiles(splitInstanceDirName(name).nativeDirName); return files?.map((file) => ({ ...file, dirName: dir(file.dirName), ...(file.sessionId ? { sessionId: qualify(file.sessionId) } : {}) })) ?? null },
    async listTopLevelSessions() { return (await store.listTopLevelSessions()).map((file) => ({ ...file, dirName: dir(file.dirName), ...(file.sessionId ? { sessionId: qualify(file.sessionId) } : {}) })) },
    listSubagentFiles: (name, id) => store.listSubagentFiles(splitInstanceDirName(name).nativeDirName, splitInstanceSessionId(id).nativeId),
    async sessionAddress(path) { const address = await store.sessionAddress(path); return address ? { ...address, dirName: dir(address.dirName) } : null },
    transcriptPath: (name, id) => store.transcriptPath(splitInstanceDirName(name).nativeDirName, splitInstanceSessionId(id).nativeId),
  }
}
export function instanceStores(): AgentStore[] {
  const instances = process.env.COGPIT_AGENT_WORKER === "1" ? [] : orchestrationStore().instances()
  const keyOf = (instance: ProviderInstance) => JSON.stringify([instance.id, instance.homeDir, instance.agent])
  const keys = new Set(instances.map(keyOf))
  for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key)
  return instances.map((instance) => {
    const key = keyOf(instance)
    let store = cache.get(key)
    if (!store) { store = createInstanceStore(instance); cache.set(key, store) }
    return store
  })
}
