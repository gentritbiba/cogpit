import type { WebContents, WebFrameMain } from "electron"

type Frame = Pick<WebFrameMain, "frameTreeNodeId" | "url"> & { parent: Frame | null }
interface Navigation { url: string; isMainFrame: boolean; frame: Frame | null; initiator?: Frame | null }

export function externalBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function createNavigationPolicy(appOrigin: string, mainFrame: () => Frame) {
  const origin = new URL(appOrigin).origin
  const shell = new URL("/api/plugins/shell/v1", origin).href
  const pluginFrames = new Set<number>()
  const belongsToPlugin = (frame: Frame | null | undefined): boolean => {
    for (let current = frame, depth = 0; current && depth < 64; current = current.parent, depth++) {
      if (pluginFrames.has(current.frameTreeNodeId)) return true
    }
    return false
  }
  return (event: Navigation, redirect = false): { allow: boolean; external?: string } => {
    let target: URL
    try { target = new URL(event.url) } catch { return { allow: false } }
    if (belongsToPlugin(event.initiator)) return { allow: false }
    const main = mainFrame()
    const initiatedByMain = event.initiator?.frameTreeNodeId === main.frameTreeNodeId
    if (belongsToPlugin(event.frame)) {
      return { allow: !redirect && initiatedByMain && (target.href === shell || target.href === "about:blank") }
    }
    if (target.href === shell) {
      if (redirect || event.isMainFrame || !event.frame || event.frame.parent?.frameTreeNodeId !== main.frameTreeNodeId) return { allow: false }
      pluginFrames.add(event.frame.frameTreeNodeId)
      return { allow: true }
    }
    if (!event.isMainFrame) return { allow: true }
    if (target.origin === origin) return { allow: true }
    const external = externalBrowserUrl(target.href)
    return { allow: false, ...(external ? { external } : {}) }
  }
}

export function installNavigationPolicy(contents: WebContents, appOrigin: string, openExternal: (url: string) => Promise<void>): void {
  const decide = createNavigationPolicy(appOrigin, () => contents.mainFrame)
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalBrowserUrl(url)
    if (external) void openExternal(external).catch(() => {})
    return { action: "deny" }
  })
  contents.on("will-frame-navigate", (event) => {
    const decision = decide(event)
    if (!decision.allow) event.preventDefault()
    if (decision.external) void openExternal(decision.external).catch(() => {})
  })
  contents.on("will-redirect", (event) => {
    const decision = decide(event, true)
    if (!decision.allow) event.preventDefault()
    if (decision.external) void openExternal(decision.external).catch(() => {})
  })
}
