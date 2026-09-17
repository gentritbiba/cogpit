import { useMemo } from "react"
import { Cloud, Github, ListChecks, Puzzle, Rocket, type LucideIcon } from "lucide-react"
import { evaluateCompatibility } from "@cogpit/plugin-contracts"
import { workspacePanelId, type RegisteredWorkspacePanel, type WorkspacePanelProps, type WorkspacePanelIndicatorProps } from "@/plugin-api"
import type { PluginHostStatus, PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import { RuntimePluginIndicator } from "./runtimeIndicators"
import { RuntimePluginPanel, type RuntimePluginPanelProps } from "./RuntimePluginPanel"
import { clientRuntimeDescriptor, type RuntimePluginClient } from "./runtimeClient"
import { workspacePanels } from "./registry"
import { useRuntimeProject } from "./useRuntimeProject"
import { browserSafeMode, useBrowserSafeMode } from "./browserSafeMode"

export { resolveRuntimeProject } from "./runtimeProject"

const bundledIcons: Readonly<Record<string, LucideIcon>> = { "cogpit.github": Github, "cogpit.clickup": ListChecks, "cogpit.vercel": Rocket, "cogpit.cloudflare": Cloud }

type RuntimeRegistration = Omit<RuntimePluginPanelProps, keyof WorkspacePanelProps>
function InstalledRuntimePanel({ runtime, ...props }: WorkspacePanelProps & { runtime?: RuntimeRegistration }) {
  return runtime ? <RuntimePluginPanel {...props} {...runtime} /> : null
}
function InstalledRuntimeIndicator({ runtime, context }: WorkspacePanelIndicatorProps & { runtime?: RuntimeRegistration }) {
  return runtime ? <RuntimePluginIndicator client={runtime.client} pluginId={runtime.plugin.id} projectId={runtime.project?.id ?? null}
    workspacePath={runtime.project ? context.projectPath : null} activation={runtime.activation} registryRevision={runtime.registryRevision} /> : null
}

export function runtimeWorkspacePanels({ client, status, activation, project, legacyPanels = workspacePanels, openSettings }: {
  client: RuntimePluginClient
  status: PluginHostStatus | null
  activation: string
  project: PluginProjectSummary | null
  legacyPanels?: readonly RegisteredWorkspacePanel[]
  openSettings?: (pluginId: string) => void
}): RegisteredWorkspacePanel[] {
  const panels = [...legacyPanels]
  if (!status?.store.available || status.safeMode || !activation || browserSafeMode()) return panels
  const ids = new Set(panels.map((panel) => panel.id))
  const descriptor = clientRuntimeDescriptor()
  for (const plugin of status.store.plugins) {
    if (!plugin.enabled || (plugin.scope.type === "projects" && (!project || !plugin.scope.projectIds.includes(project.id)))) continue
    if (!evaluateCompatibility(plugin.manifest, descriptor, status.runtime, { allowPrerelease: plugin.manifest.publisher.startsWith("dev-") }).compatible) continue
    for (const contribution of plugin.manifest.contributes.panels) {
      const id = workspacePanelId(plugin.id, contribution.id)
      if (ids.has(id) || (contribution.when === "project-selected" && !project)) continue
      ids.add(id)
      const runtime: RuntimeRegistration = { client, plugin, activation, registryRevision: status.store.revision, project, title: contribution.title, openSettings }
      panels.push({ id, pluginId: plugin.id, localId: contribution.id, title: contribution.title, icon: bundledIcons[plugin.id] ?? Puzzle,
        order: contribution.order, defaultSize: contribution.defaultSize, minSize: contribution.minSize, maxSize: contribution.maxSize,
        keepAlive: true,
        ...(bundledIcons[plugin.id] ? { indicator: InstalledRuntimeIndicator, indicatorProps: { runtime } } : {}),
        component: InstalledRuntimePanel, componentProps: { runtime },
      })
    }
  }
  return panels.sort((left, right) => (left.order ?? 100) - (right.order ?? 100) || left.title.localeCompare(right.title))
}

export function useRuntimeWorkspacePanels({ client, status, activation, projectPath, openSettings }: {
  client: RuntimePluginClient
  status: PluginHostStatus | null
  activation: string
  projectPath: string | null
  openSettings?: (pluginId: string) => void
}): RegisteredWorkspacePanel[] {
  const safeMode = useBrowserSafeMode()
  const { project, resolving } = useRuntimeProject({ client, status, activation, projectPath })
  return useMemo(() => {
    return runtimeWorkspacePanels({ client, status, activation: safeMode || resolving ? "" : activation, project, openSettings })
  }, [client, status, activation, project, resolving, safeMode, openSettings])
}
