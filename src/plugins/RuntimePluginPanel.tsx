import { X } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import type { WorkspacePanelProps } from "@/plugin-api"
import type { InstalledPlugin } from "../../shared/contracts/plugins"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import { PluginFrame } from "./PluginFrame"
import { pluginPanelContext, usePluginPresentation } from "./runtimeContext"
import { createRuntimePanelActivation, type RuntimePanelActivation, type RuntimePanelClient } from "./runtimePanelActivation"
import { Button } from "@/components/ui/button"
import { usePluginExternalLink } from "./PluginExternalLink"
import { useBrowserSafeMode } from "./browserSafeMode"

export interface RuntimePluginPanelProps extends WorkspacePanelProps {
  client: RuntimePanelClient
  plugin: InstalledPlugin
  activation: string
  registryRevision: number
  project: PluginProjectSummary | null
  title?: string
  openSettings?: (pluginId: string) => void
}

export function RuntimePluginPanel(props: RuntimePluginPanelProps) {
  const safeMode = useBrowserSafeMode()
  const epoch = JSON.stringify([props.activation, props.registryRevision, props.plugin.id, props.plugin.selectedDigest])
  if (!props.activation || !props.plugin.enabled || safeMode) return null
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
      {props.openSettings && props.plugin.manifest.permissions.connections.length > 0 && <Button size="sm" variant="ghost" onClick={() => props.openSettings?.(props.plugin.id)}>Connections</Button>}
      <Button size="icon-sm" variant="ghost" aria-label={`Close ${props.title ?? props.plugin.manifest.name}`} onClick={props.closePanel}><X className="size-4" /></Button>
    </div>
    <div className="min-h-0 flex-1"><RuntimePluginPanelCache key={epoch} {...props} /></div>
  </div>
}

const MAX_CACHED_PROJECTS = 3
function RuntimePluginPanelCache(props: RuntimePluginPanelProps) {
  const key = JSON.stringify([props.project?.id, props.project?.name, props.context.projectPath])
  const current = { key, project: props.project, path: props.context.projectPath }
  const [cache, setCache] = useState({ entries: [current], recent: [key] })
  let entries = cache.entries
  if (cache.recent.at(-1) !== key) {
    const recent = [...cache.recent.filter(value => value !== key), key].slice(-MAX_CACHED_PROJECTS)
    entries = cache.entries.filter(entry => recent.includes(entry.key))
    if (!entries.some(entry => entry.key === key)) entries = [...entries, current]
    setCache({ entries, recent })
  }
  return entries.map(entry => <div key={entry.key} className="h-full min-h-0" hidden={entry.key !== key}>
    <RuntimePluginPanelSession {...props} epoch={entry.key} project={entry.project}
      context={{ ...props.context, projectPath: entry.path }} active={props.active && entry.key === key} />
  </div>)
}

function RuntimePluginPanelSession({ client, plugin, project, active, title, epoch, context }: RuntimePluginPanelProps & { epoch: string }) {
  const presentation = usePluginPresentation()
  const { openExternal, dialog } = usePluginExternalLink(plugin.manifest.name)
  const [contextEpoch] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  const currentActive = useRef(active)
  const composePrompt = useRef(context.composePrompt)
  const openSession = useRef(context.openSession)
  const activation = useRef<RuntimePanelActivation | null>(null)
  const sessionKey = JSON.stringify([context.session?.sessionId, context.sessionChangeKey])
  const [loaded, setLoaded] = useState<{ payload: ArrayBuffer; leaseId: string; runtime: RuntimePanelActivation } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { currentActive.current = active; activation.current?.setActive(active) }, [active])
  useLayoutEffect(() => { activation.current?.resetSession() }, [sessionKey])
  useLayoutEffect(() => { composePrompt.current = context.composePrompt }, [context.composePrompt])
  useLayoutEffect(() => { openSession.current = context.openSession }, [context.openSession])
  const pluginId = plugin.id, digest = plugin.selectedDigest, projectId = project?.id ?? null
  const canAppend = plugin.manifest.permissions.composer.includes("append") && !!context.composePrompt
  const canOpenSession = plugin.manifest.permissions.navigation.includes("session") && !!context.openSession
  const workspacePath = project ? context.projectPath : null
  const canOpenExternal = plugin.manifest.permissions.navigation.includes("external")
  useLayoutEffect(() => {
    const runtime = createRuntimePanelActivation({ client, pluginId, digest, projectId, workspacePath, contextEpoch, active: currentActive.current,
      ...(canAppend ? { appendDraft: (text: string) => composePrompt.current?.(text) } : {}),
      ...(canOpenSession ? { openSession: (dirName: string, fileName: string) => openSession.current?.(dirName, fileName) } : {}),
      ...(canOpenExternal ? { openExternal } : {}),
      onLoaded: (payload, leaseId) => setLoaded({ payload, leaseId, runtime }), onError: (failure) => setError(failure.message) })
    activation.current = runtime
    return () => { runtime.dispose(); activation.current = null }
  }, [client, pluginId, digest, projectId, epoch, contextEpoch, canAppend, canOpenExternal, openExternal, canOpenSession, workspacePath])
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
  if (!loaded) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading plugin…</p>
  return <><PluginFrame payload={loaded.payload} digest={digest} activationKey={`${epoch}:${loaded.leaseId}`}
    context={pluginPanelContext(plugin.manifest, project, active, presentation)} active={active} title={title ?? plugin.manifest.name}
    execute={loaded.runtime.execute} onError={loaded.runtime.fail} />{dialog}</>
}
