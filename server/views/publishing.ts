/**
 * Publishing a stored view through a plugin: this computer composes the
 * public page from the version's finished page and the publisher's two
 * themes, the plugin's connection sends it to its host, and view.json records
 * where it went so the same address can be updated or taken down.
 */
import type { IncomingMessage } from "node:http"
import { RouteError } from "../lib/routeError"
import type { PluginManager } from "../plugins/manager"
import { publishedViewDocument, type PublishThemes, type ViewPublication } from "../../shared/views/publish"
import { viewPublication, type ViewStore } from "./store"

interface PublishInput {
  manager: PluginManager
  store: ViewStore
  req: IncomingMessage
  leaseId: string
  view: string
  signal: AbortSignal
}

const missing = () => new RouteError(404, "NOT_FOUND", "This view is no longer on this computer")
const otherPublisher = (title: string) => new RouteError(409, "CONFLICT", `This view is published with ${title}; take it down there first`)

/** Publishes `version`, replacing the page this plugin already published for the view. */
export async function publishView({ manager, store, req, leaseId, view, signal }: PublishInput, version: number, themes: PublishThemes): Promise<ViewPublication> {
  const pluginId = manager.resolveLease(req, leaseId).pluginId
  const found = await store.readVersion(view, version)
  if (!found) throw missing()
  const previous = found.record.published
  if (previous && previous.pluginId !== pluginId) throw otherPublisher(previous.title)
  const page = await manager.publish(req, leaseId, publishedViewDocument(found.html, themes), previous?.slug, { signal })
  try {
    const record = await store.setPublished(view, { pluginId, title: page.title, url: page.url, slug: page.slug, version, publishedAt: new Date().toISOString() })
    return viewPublication(record)!
  } catch (error) {
    // Deleted while the page uploaded: a public page Cogpit no longer knows about must not stay up.
    if (!previous) await manager.unpublish(req, leaseId, page.slug, { signal }).catch(() => {})
    throw error
  }
}

/** Takes the view's page down and forgets it. */
export async function unpublishView({ manager, store, req, leaseId, view, signal }: PublishInput): Promise<void> {
  const pluginId = manager.resolveLease(req, leaseId).pluginId
  const record = await store.read(view)
  if (!record) throw missing()
  const published = record.published
  if (!published) return
  if (published.pluginId !== pluginId) throw otherPublisher(published.title)
  await manager.unpublish(req, leaseId, published.slug, { signal })
  await store.setPublished(view, null)
}
