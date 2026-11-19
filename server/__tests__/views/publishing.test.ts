// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginManager } from "../../plugins/manager"
import { createViewStore, type ViewStore } from "../../views/store"
import { publishView, unpublishView } from "../../views/publishing"
import { VIEW_THEME_TOKEN } from "../../../shared/views/frame"

let root: string
let store: ViewStore
let pluginId: string
const manager = {
  resolveLease: vi.fn(() => ({ pluginId })),
  publish: vi.fn(async (_req: unknown, _lease: string, _html: string, slug?: string) => ({ title: "Share host", url: `https://share.example.com/${slug ?? "minted"}/`, slug: slug ?? "minted" })),
  unpublish: vi.fn(async () => {}),
}
const themes = { light: { "--card": "white" }, dark: { "--card": "black" } }
const target = (view = "funnel") => ({ manager: manager as unknown as PluginManager, store, req: {} as IncomingMessage, leaseId: "lease", view, signal: new AbortController().signal })

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cogpit-view-publishing-"))
  store = createViewStore(root)
  pluginId = "dev-me.share"
  vi.clearAllMocks()
  await store.create({ id: "funnel", title: "Funnel", project: "/work/app", sessionId: "s1" })
  await store.addVersion("funnel", { files: [], html: `<head><script>(kit)(${VIEW_THEME_TOKEN})</script></head><p>one</p>` })
  await store.addVersion("funnel", { files: [], html: `<head><script>(kit)(${VIEW_THEME_TOKEN})</script></head><p>two</p>` })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("publishing a stored view", () => {
  it("sends the version's page with both themes, records it, and updates the same page later", async () => {
    const first = await publishView(target(), 1, themes)
    expect(first).toMatchObject({ pluginId, title: "Share host", url: "https://share.example.com/minted/", version: 1 })
    const [, , html, slug] = manager.publish.mock.calls[0]!
    expect(slug).toBeUndefined()
    expect(html).toContain("<p>one</p>")
    expect(html).not.toContain(VIEW_THEME_TOKEN)
    expect(html).toContain(`"--card":"black"`)
    expect((await store.read("funnel"))?.published).toMatchObject({ slug: "minted", version: 1 })

    expect(await publishView(target(), 2, themes)).toMatchObject({ url: "https://share.example.com/minted/", version: 2 })
    expect(manager.publish.mock.calls[1]![3]).toBe("minted")
  })

  it("refuses a missing version and another plugin's page", async () => {
    await expect(publishView(target(), 9, themes)).rejects.toMatchObject({ status: 404 })
    await expect(publishView(target("nothing"), 1, themes)).rejects.toMatchObject({ status: 404 })
    await publishView(target(), 1, themes)
    pluginId = "dev-me.other"
    await expect(publishView(target(), 2, themes)).rejects.toMatchObject({ status: 409 })
    await expect(unpublishView(target())).rejects.toMatchObject({ status: 409 })
    expect(manager.unpublish).not.toHaveBeenCalled()
  })

  it("takes the page down and forgets it, and treats an unpublished view as done", async () => {
    await unpublishView(target())
    expect(manager.unpublish).not.toHaveBeenCalled()
    await publishView(target(), 1, themes)
    await unpublishView(target())
    expect(manager.unpublish).toHaveBeenCalledWith(expect.anything(), "lease", "minted", expect.anything())
    expect((await store.read("funnel"))?.published).toBeUndefined()
  })

  it("keeps the record when the host fails to take the page down", async () => {
    await publishView(target(), 1, themes)
    manager.unpublish.mockRejectedValueOnce(new Error("upstream"))
    await expect(unpublishView(target())).rejects.toThrow("upstream")
    expect((await store.read("funnel"))?.published).toMatchObject({ slug: "minted" })
  })

  it("takes down a fresh page when the view vanished while it uploaded", async () => {
    manager.publish.mockImplementationOnce(async () => {
      await store.remove("funnel")
      return { title: "Share host", url: "https://share.example.com/late/", slug: "late" }
    })
    await expect(publishView(target(), 1, themes)).rejects.toThrow(/No view/)
    expect(manager.unpublish).toHaveBeenCalledWith(expect.anything(), "lease", "late", expect.anything())
  })
})
