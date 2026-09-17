import { describe, expect, it } from "vitest"
import { createNavigationPolicy, externalBrowserUrl } from "../navigationPolicy"

const origin = "http://127.0.0.1:19384"
const shell = `${origin}/api/plugins/shell/v1`
const main = { frameTreeNodeId: 1, url: origin, parent: null }
function setup() {
  const plugin = { frameTreeNodeId: 2, url: "about:blank", parent: main }
  const policy = createNavigationPolicy(origin, () => main)
  expect(policy({ url: shell, isMainFrame: false, frame: plugin, initiator: main })).toEqual({ allow: true })
  return { policy, plugin }
}
describe("desktop plugin navigation boundary", () => {
  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "cogpit://session", "mailto:test@example.test", "https://user:pass@example.test/"])("does not launch %s", (url) => expect(externalBrowserUrl(url)).toBeNull())
  it("compares the exact app origin and permits normal browser links", () => {
    const { policy } = setup()
    expect(policy({ url: `${origin}/sessions`, isMainFrame: true, frame: main, initiator: main })).toEqual({ allow: true })
    expect(policy({ url: `${origin}.example.test/`, isMainFrame: true, frame: main, initiator: main })).toEqual({ allow: false })
    expect(policy({ url: "https://example.test/help", isMainFrame: true, frame: main, initiator: main })).toEqual({ allow: false, external: "https://example.test/help" })
  })
  it("denies plugin navigation and redirects after its URL changes", () => {
    const { policy, plugin } = setup()
    plugin.url = "https://changed.example.test/"
    for (const url of [shell, origin, "about:blank", "https://example.test/", "file:///tmp/file"]) {
      expect(policy({ url, isMainFrame: false, frame: plugin, initiator: plugin })).toEqual({ allow: false })
      expect(policy({ url, isMainFrame: false, frame: plugin }, true)).toEqual({ allow: false })
    }
  })
  it("denies navigation initiated by plugin descendants to other frames", () => {
    const { policy, plugin } = setup()
    const child = { frameTreeNodeId: 3, url: "about:blank", parent: plugin }
    expect(policy({ url: "https://example.test", isMainFrame: true, frame: main, initiator: child })).toEqual({ allow: false })
  })
  it("allows trusted parent cleanup and reinitialization, preserving unrelated previews", () => {
    const { policy, plugin } = setup()
    expect(policy({ url: "about:blank", isMainFrame: false, frame: plugin, initiator: main })).toEqual({ allow: true })
    expect(policy({ url: shell, isMainFrame: false, frame: plugin, initiator: main })).toEqual({ allow: true })
    const preview = { frameTreeNodeId: 4, url: "http://localhost:3000", parent: main }
    expect(policy({ url: "http://localhost:3000/page", isMainFrame: false, frame: preview, initiator: preview })).toEqual({ allow: true })
  })
  it("does not let redirects or top-level navigation enter the shell", () => {
    const policy = createNavigationPolicy(origin, () => main)
    expect(policy({ url: shell, isMainFrame: true, frame: main, initiator: main })).toEqual({ allow: false })
    expect(policy({ url: shell, isMainFrame: false, frame: { frameTreeNodeId: 2, url: "https://example.test", parent: main }, initiator: main }, true)).toEqual({ allow: false })
  })
})
