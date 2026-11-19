import { useCallback } from "react"
import { evaluateCompatibility } from "@cogpit/plugin-contracts"
import type { InstalledPlugin } from "../../../shared/contracts/plugins"
import type { ViewPublication } from "../../../shared/views/publish"
import { useRuntimeContributions } from "@/plugins/RuntimePluginContributions"
import { clientRuntimeDescriptor, PluginRequestError } from "@/plugins/runtimeClient"
import { readLightAndDarkTokens } from "@/plugins/runtimeContext"
import { withLease } from "@/plugins/lease"
import { announceViewsChanged, rememberViews, viewsScope } from "@/components/timeline/cogpit-blocks/view/storedView"

export type ViewPublisher = InstalledPlugin & { manifest: { contributes: { publish: NonNullable<InstalledPlugin["manifest"]["contributes"]["publish"]> } } }

/** Words for a failed publish or take-down, naming the plugin's host. */
export function publishFailure(error: unknown, host: string): string {
  const code = error instanceof PluginRequestError ? error.code : ""
  if (code === "CONNECTION_REQUIRED" || code === "RESOURCE_REQUIRED") return `Connect ${host} in Plugins first.`
  if (code === "UPSTREAM_FAILED") return `${host} refused the request. Check its connection in Plugins.`
  if (code === "INVALID_RESPONSE") return `${host} did not answer with the page's address.`
  if (code === "RATE_LIMITED") return "Too many uploads are running. Try again in a moment."
  if (code === "NOT_FOUND" || code === "CONFLICT" || code === "SESSION_ACCESS_DENIED") return (error as Error).message
  return `${host} could not be reached. Try again.`
}

/**
 * The installed plugins that publish views, and publishing through them. A
 * view is published from the computer that holds it, so these are the active
 * device's plugins, the same runtime its views come from.
 */
export function useViewPublishing() {
  const runtime = useRuntimeContributions()
  const status = runtime?.status
  const usable = !!runtime?.activation && !!status?.store.available && !status.safeMode
  const publishers = usable ? status.store.plugins.filter((plugin): plugin is ViewPublisher => !!plugin.manifest.contributes.publish && plugin.enabled
    && (plugin.scope.type === "all" || !!runtime.project && plugin.scope.projectIds.includes(runtime.project.id))
    && evaluateCompatibility(plugin.manifest, clientRuntimeDescriptor(), status.runtime, { allowPrerelease: plugin.manifest.publisher.startsWith("dev-") }).compatible) : []

  const remember = useCallback((id: string, published: ViewPublication | undefined) => {
    rememberViews(viewsScope(), [{ id, latestVersion: null, published }])
    announceViewsChanged()
  }, [])

  const publish = useCallback(async (publisher: ViewPublisher, id: string, version: number): Promise<ViewPublication> => {
    if (!runtime) throw new Error("Plugins are not available")
    const signal = AbortSignal.timeout(60_000)
    const publication = await withLease(runtime, publisher, signal, (leaseId) => runtime.client.publishView(leaseId, { view: id, version, themes: readLightAndDarkTokens() }, signal))
    remember(id, publication)
    return publication
  }, [runtime, remember])

  const unpublish = useCallback(async (publisher: ViewPublisher, id: string): Promise<void> => {
    if (!runtime) throw new Error("Plugins are not available")
    const signal = AbortSignal.timeout(60_000)
    await withLease(runtime, publisher, signal, (leaseId) => runtime.client.unpublishView(leaseId, { view: id }, signal))
    remember(id, undefined)
  }, [runtime, remember])

  /** The installed plugin that published `publication`, which alone can update or take it down. */
  const publisherOf = (publication: ViewPublication | null | undefined) => publication ? publishers.find((plugin) => plugin.id === publication.pluginId) ?? null : null

  return { publishers, publish, unpublish, publisherOf }
}
