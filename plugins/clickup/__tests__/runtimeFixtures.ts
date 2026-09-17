import { vi } from "vitest"
import type { JsonValue, PluginClient, PluginContext } from "@cogpit/plugin-sdk"
export const runtimeContext: PluginContext = { project: { id: "project.one", name: "Example" }, theme: { mode: "dark", tokens: {} }, locale: "en", reducedMotion: false, visible: true }
export const viewer = { id: 7, username: "Alex", initials: "AL", color: "#123456" }
export const connectionStatus = { configured: true, readOnly: false, selected: { workspace: { id: "10", label: "Example workspace" }, space: { id: "20", label: "Development" }, list: { id: "30", label: "Sprint" } } }
export const list = { id: "30", name: "Sprint", folder: { name: "Product", hidden: false }, space: { id: "20" }, statuses: [] }
export function rawTask(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Task ${id}`, custom_id: `APP-${id}`, markdown_description: "Description for the task", status: { status: "to do", type: "open", color: "#555", orderindex: 0 }, list: { id: "30", name: "Sprint" }, folder: { name: "Product" }, space: { id: "20" }, assignees: [viewer], date_created: "1000", date_updated: "2000", ...extra }
}
export function fakeClient(): PluginClient {
  return {
    context: runtimeContext,
    ready: vi.fn().mockResolvedValue(null),
    integrations: { request: vi.fn() },
    connections: {
      status: vi.fn().mockResolvedValue(connectionStatus),
      request: vi.fn(async (_handle, operation): Promise<JsonValue> => {
        if (operation === "viewer") return { user: viewer }
        if (operation === "list") return list
        return { tasks: [rawTask("1")], last_page: true }
      }),
    },
    composer: { append: vi.fn().mockResolvedValue(null) },
    navigation: { openExternal: vi.fn().mockResolvedValue(null), openSession: vi.fn().mockResolvedValue(null) },
    storage: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(null), delete: vi.fn().mockResolvedValue(null) },
    onContextChange: vi.fn(() => () => undefined), onThemeChange: vi.fn(() => () => undefined), onVisibilityChange: vi.fn(() => () => undefined), dispose: vi.fn(),
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
