import type { DraftMethod, DraftMethodMap } from "@cogpit/plugin-contracts"
import type { InstalledPlugin } from "../../shared/contracts/plugins"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import { resolveRuntimeProject } from "./runtimeProject"

/**
 * Release-owned browser code that an installed plugin turns on. Each module
 * lives at `src/clientIntegrations/<directory>/index.ts`, is loaded only when
 * an enabled, release-provenance plugin holds the matching grant, and is
 * disposed when that stops being true. Disposal never deletes saved data.
 */
export interface ClientIntegrationContext {
  pluginId: string
  /** Aborted when the plugin is disabled, uninstalled, loses its grant or provenance, or safe mode starts, or the host or signed-in user changes. */
  signal: AbortSignal
  /** Whether the plugin's current project scope covers a composer directory; re-read on every call. */
  inScope(cwd: string | null): boolean
}

export interface DraftsIntegration {
  /** Answers a frame's drafts request after the host has authorized it under the frame's lease. */
  request<M extends DraftMethod>(method: M, params: DraftMethodMap[M]["params"], signal: AbortSignal): Promise<DraftMethodMap[M]["result"]>
  /** Reports the composer token frames should use next. */
  onTokenChange(listener: (token: string) => void): () => void
  dispose(): void
}

export interface ClientIntegrationModule { activate(context: ClientIntegrationContext): DraftsIntegration }

const CAPABILITIES = {
  "composer.drafts": { directory: "composer-drafts", version: "1.0.0", granted: (plugin: InstalledPlugin) => plugin.manifest.permissions.composer.includes("drafts") },
} as const
type Capability = keyof typeof CAPABILITIES
const modules = import.meta.glob<ClientIntegrationModule>("../clientIntegrations/*/index.ts")
const loaderFor = (capability: Capability) => modules[`../clientIntegrations/${CAPABILITIES[capability].directory}/index.ts`]

/** Client capabilities this build can actually serve. */
export function clientIntegrationCapabilities(): Record<string, string> {
  return Object.fromEntries(Object.entries(CAPABILITIES).filter(([capability]) => loaderFor(capability as Capability)).map(([capability, { version }]) => [capability, version]))
}

interface Activation { key: string; controller: AbortController; integration: DraftsIntegration | null }
export interface ClientIntegrationState { plugins: readonly InstalledPlugin[]; privilegedPluginIds: readonly string[]; projects: readonly PluginProjectSummary[]; platform: string; safeMode: boolean }
const EMPTY_STATE: ClientIntegrationState = { plugins: [], privilegedPluginIds: [], projects: [], platform: "", safeMode: false }

export class ClientIntegrationHost {
  private active = new Map<string, Activation>()
  private listeners = new Set<() => void>()
  private state = EMPTY_STATE
  constructor(private load: (capability: Capability) => (() => Promise<ClientIntegrationModule>) | undefined = loaderFor) {}

  /** Activates eligible plugins and disposes the rest; call with every plugin snapshot change. */
  sync(state: ClientIntegrationState): void {
    this.state = state
    const wanted = new Map<string, InstalledPlugin>()
    if (!state.safeMode) for (const plugin of state.plugins) {
      if (plugin.enabled && state.privilegedPluginIds.includes(plugin.id) && CAPABILITIES["composer.drafts"].granted(plugin)) wanted.set(plugin.id, plugin)
    }
    for (const [id, activation] of this.active) {
      const plugin = wanted.get(id)
      if (!plugin || activation.key !== plugin.selectedDigest) this.deactivate(id)
    }
    for (const [id, plugin] of wanted) if (!this.active.has(id)) this.activate(plugin)
  }

  drafts(pluginId: string): DraftsIntegration | null { return this.active.get(pluginId)?.integration ?? null }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  dispose(): void { for (const id of [...this.active.keys()]) this.deactivate(id) }

  private activate(plugin: InstalledPlugin): void {
    const load = this.load("composer.drafts")
    if (!load) return
    const activation: Activation = { key: plugin.selectedDigest, controller: new AbortController(), integration: null }
    this.active.set(plugin.id, activation)
    void load().then((module) => {
      if (activation.controller.signal.aborted) return
      activation.integration = module.activate({ pluginId: plugin.id, signal: activation.controller.signal, inScope: (cwd) => this.inScope(plugin.id, cwd) })
      this.notify()
    }).catch(() => { if (this.active.get(plugin.id) === activation) this.active.delete(plugin.id) })
  }

  private inScope(pluginId: string, cwd: string | null): boolean {
    const plugin = this.state.plugins.find((value) => value.id === pluginId)
    if (!plugin?.enabled || !this.active.has(pluginId)) return false
    if (plugin.scope.type === "all") return true
    const project = resolveRuntimeProject(this.state.projects, cwd, this.state.platform)
    return !!project && plugin.scope.projectIds.includes(project.id)
  }

  private deactivate(id: string): void {
    const activation = this.active.get(id)
    if (!activation) return
    this.active.delete(id)
    activation.controller.abort()
    try { activation.integration?.dispose() } finally { this.notify() }
  }

  private notify(): void { for (const listener of [...this.listeners]) listener() }
}
