import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import type { ParsedSession } from "../../shared/session/types"

export interface ProjectPromptContext {
  path: string
  text?: string
  startLine?: number
  endLine?: number
  comment?: string
}

/** Stable workspace data available to every compile-time panel plugin. */
export interface WorkspacePanelContext {
  session: ParsedSession | null
  sessionChangeKey: number
  projectPath: string | null
  hasFileChanges: boolean
  canAccessHostFiles: boolean
  supportsWorktrees?: boolean
  /** Navigate to a session by its storage address; absent where the host cannot switch sessions. */
  openSession?: (dirName: string, fileName: string) => void
  /** Append text to the message composer and focus it; absent where there is no composer. */
  composePrompt?: (text: string) => void
}

export interface WorkspacePanelProps {
  context: WorkspacePanelContext
  active: boolean
  closePanel: () => void
  openPanel: (panelId: string) => void
}

export interface WorkspacePanelIndicatorProps {
  context: WorkspacePanelContext
  active: boolean
}

export interface WorkspacePanelDefinition {
  /** Plugin-local id. The registry qualifies it as `<plugin-id>.<panel-id>`. */
  id: string
  title: string
  icon: LucideIcon
  component: ComponentType<WorkspacePanelProps>
  order?: number
  /** Initial share of the workspace, with an explicit CSS unit such as `40%`. */
  defaultSize?: string
  /** Smallest useful panel width, with an explicit CSS unit such as `320px`. */
  minSize?: string
  /** Largest useful panel width, with an explicit CSS unit such as `70%`. */
  maxSize?: string
  /** Keep state mounted after the user switches to another panel. */
  keepAlive?: boolean
  when?: (context: WorkspacePanelContext) => boolean
  badge?: (context: WorkspacePanelContext) => string | number | null
  /** Live status rendered on top of the activity-rail icon. */
  indicator?: ComponentType<WorkspacePanelIndicatorProps>
}

export interface CogpitPlugin {
  id: string
  workspacePanels?: readonly WorkspacePanelDefinition[]
}

export interface RegisteredWorkspacePanel extends Omit<WorkspacePanelDefinition, "id"> {
  id: string
  pluginId: string
  localId: string
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

function assertId(kind: "plugin" | "panel", id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid Cogpit ${kind} id "${id}"`)
  }
}

export function workspacePanelId(pluginId: string, panelId: string): string {
  return `${pluginId}.${panelId}`
}

export function definePlugin(plugin: CogpitPlugin): CogpitPlugin {
  return plugin
}

/** Validate, qualify, and order all compile-time workspace panels. */
export function collectWorkspacePanels(
  plugins: readonly CogpitPlugin[],
): RegisteredWorkspacePanel[] {
  const pluginIds = new Set<string>()
  const panelIds = new Set<string>()
  const panels: RegisteredWorkspacePanel[] = []

  for (const plugin of plugins) {
    assertId("plugin", plugin.id)
    if (pluginIds.has(plugin.id)) throw new Error(`Duplicate Cogpit plugin id "${plugin.id}"`)
    pluginIds.add(plugin.id)

    for (const panel of plugin.workspacePanels ?? []) {
      assertId("panel", panel.id)
      const id = workspacePanelId(plugin.id, panel.id)
      if (panelIds.has(id)) throw new Error(`Duplicate Cogpit workspace panel id "${id}"`)
      panelIds.add(id)
      panels.push({ ...panel, id, pluginId: plugin.id, localId: panel.id })
    }
  }

  return panels.sort((left, right) =>
    (left.order ?? 100) - (right.order ?? 100)
      || left.title.localeCompare(right.title),
  )
}
