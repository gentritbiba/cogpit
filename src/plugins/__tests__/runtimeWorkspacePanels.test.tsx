import { canonicalPluginPanelId, resolvePluginPanelPreference } from "../panelAliases"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Puzzle } from "lucide-react"
import type { RuntimePluginClient } from "../runtimeClient"
import type { RegisteredWorkspacePanel } from "@/plugin-api"
import { runtimeWorkspacePanels, resolveRuntimeProject } from "../runtimeWorkspacePanels"
import { panelClientDescriptor, panelHostStatus, panelPlugin, panelProject } from "./runtimePanelFixtures"

vi.mock("../runtimeClient", async () => {
  const fixtures = await import("./runtimePanelFixtures")
  return { clientRuntimeDescriptor: () => fixtures.panelClientDescriptor }
})
vi.mock("../registry", () => ({ workspacePanels: [] }))

const client = {} as RuntimePluginClient
const legacy: RegisteredWorkspacePanel = { id: "cogpit.built-in", pluginId: "cogpit", localId: "built-in", title: "Built-in", icon: Puzzle, component: () => null, order: 0 }
function panels(status = panelHostStatus, project: typeof panelProject | null = panelProject) {
  return runtimeWorkspacePanels({ client, status, activation: "host-session", project, legacyPanels: [legacy] })
}
afterEach(() => { window.history.replaceState(null, "", "/") })

describe("runtime workspace registry", () => {
  it("keeps component types stable when switching projects or receiving a new host snapshot", () => {
    const first = panels()[1], next = panels(structuredClone(panelHostStatus), { ...panelProject, id: "another-project" })[1]
    expect(next.component).toBe(first.component)
    expect(next.componentProps).not.toEqual(first.componentProps)
  })
  it("retains static panels and qualifies enabled runtime contributions", () => {
    expect(panels().map((panel) => panel.id)).toEqual([legacy.id, "example.sample.sample"])
    expect(panels()[1]).toMatchObject({ icon: Puzzle, keepAlive: true })
  })
  it("does not replace a static panel with a duplicate runtime ID", () => {
    const duplicate = { ...legacy, id: "example.sample.sample" }
    expect(runtimeWorkspacePanels({ client, status: panelHostStatus, activation: "host-session", project: panelProject, legacyPanels: [duplicate] })).toEqual([duplicate])
  })
  it("filters disabled, out-of-scope, unavailable and incompatible plugins", () => {
    for (const plugin of [{ ...panelPlugin, enabled: false }, { ...panelPlugin, scope: { type: "projects" as const, projectIds: ["other"] } },
      { ...panelPlugin, manifest: { ...panelPlugin.manifest, requires: { client: { "unavailable.feature": "^1.0.0" }, host: {} } } }]) {
      expect(panels({ ...panelHostStatus, store: { ...panelHostStatus.store, plugins: [plugin] } })).toEqual([legacy])
    }
    expect(panels({ ...panelHostStatus, store: { ...panelHostStatus.store, available: false } })).toEqual([legacy])
    expect(panels(panelHostStatus, null)).toEqual([legacy])
    expect(panelClientDescriptor.capabilities).toEqual({})
  })
  it("resolves saved panel preferences to the installed implementation", () => {
    const old = { ...legacy, id: "clickup.tasks", pluginId: "clickup" }
    const current = { ...legacy, id: "cogpit.clickup.tasks", pluginId: "cogpit.clickup" }
    expect(resolvePluginPanelPreference(old.id, [current])).toBe(current)
    expect(resolvePluginPanelPreference(old.id, [old])).toBe(old)
    expect(resolvePluginPanelPreference(old.id, [legacy])).toBeNull()
    expect(canonicalPluginPanelId(old.id)).toBe(canonicalPluginPanelId(current.id))
  })
  it("preserves static panels in host or URL safe mode", () => {
    expect(panels({ ...panelHostStatus, safeMode: true })).toEqual([legacy])
    window.history.replaceState(null, "", "/?pluginSafeMode=1")
    expect(panels()).toEqual([legacy])
  })
})

describe("runtime project matching", () => {
  it("chooses the longest canonical ancestor and respects path boundaries", () => {
    const nested = { ...panelProject, id: "nested", paths: ["/private/repo/nested"] }
    expect(resolveRuntimeProject([panelProject, nested], "/private/repo/nested/src", "linux")).toBe(nested)
    expect(resolveRuntimeProject([panelProject], "/private/repo/src", "linux")).toBe(panelProject)
    expect(resolveRuntimeProject([panelProject], "/private/repository", "linux")).toBeNull()
    expect(resolveRuntimeProject([panelProject], "/private/repo/../elsewhere", "linux")).toBeNull()
  })
  it("normalizes Windows separators and case only for Windows hosts", () => {
    const project = { ...panelProject, paths: ["C:\\Work\\Repo\\"] }
    expect(resolveRuntimeProject([project], "c:/work/repo/src", "win32")).toBe(project)
    expect(resolveRuntimeProject([project], "c:/work/repo/src", "linux")).toBeNull()
  })
})
