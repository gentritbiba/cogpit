import { useEffect, useState } from "react"
import type { PluginHostStatus, PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import type { RuntimePluginClient } from "./runtimeClient"
import { resolveRuntimeProject } from "./runtimeProject"

export function useRuntimeProject({ client, status, activation, projectPath }: {
  client: Pick<RuntimePluginClient, "resolveWorkspace">
  status: PluginHostStatus | null
  activation: string
  projectPath: string | null
}): { project: PluginProjectSummary | null; resolving: boolean } {
  const available = !!status?.store.available && !!activation
  const immediate = available ? resolveRuntimeProject(status.projects, projectPath, status.runtime.platform) : null
  const requestPath = available && !immediate ? projectPath : null
  const key = JSON.stringify([activation, projectPath, status?.host.instanceId, status?.store.revision, status?.connectionRevision, status?.projects])
  const [resolved, setResolved] = useState<{ key: string; project: PluginProjectSummary | null } | null>(null)
  useEffect(() => {
    if (!requestPath) return
    const controller = new AbortController()
    void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return client.resolveWorkspace(requestPath, controller.signal) }).then(project => {
      if (!controller.signal.aborted) setResolved({ key, project })
    }).catch(() => {
      if (!controller.signal.aborted) setResolved({ key, project: null })
    })
    return () => controller.abort()
  }, [client, key, requestPath])
  if (!available || !projectPath) return { project: null, resolving: false }
  if (immediate) return { project: immediate, resolving: false }
  return resolved?.key === key ? { project: resolved.project, resolving: false } : { project: null, resolving: true }
}
