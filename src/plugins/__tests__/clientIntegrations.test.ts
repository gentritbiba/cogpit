// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ClientIntegrationHost, type ClientIntegrationContext } from "../clientIntegrations"
import type { InstalledPlugin } from "../../../shared/contracts/plugins"

function plugin(overrides: { enabled?: boolean; composer?: string[]; digest?: string; projectIds?: string[] } = {}): InstalledPlugin {
  return { id: "cogpit.saved-drafts", selectedDigest: overrides.digest ?? "a".repeat(64), enabled: overrides.enabled ?? true, scope: overrides.projectIds ? { type: "projects", projectIds: overrides.projectIds } : { type: "all" }, pinned: false, versions: [],
    manifest: { permissions: { composer: overrides.composer ?? ["drafts"] } } } as unknown as InstalledPlugin
}
const projects = [{ id: `p_${"1".repeat(40)}`, name: "one", paths: ["/work/one"] }, { id: `p_${"2".repeat(40)}`, name: "two", paths: ["/work/two"] }]
const state = (plugins: InstalledPlugin[], privilegedPluginIds: string[] = ["cogpit.saved-drafts"], safeMode = false) => ({ plugins, privilegedPluginIds, projects, platform: "linux", safeMode })
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve() }
function host() {
  const contexts: ClientIntegrationContext[] = []
  const dispose = vi.fn()
  const value = new ClientIntegrationHost(() => async () => ({ activate: (context) => { contexts.push(context); return { request: vi.fn(), onTokenChange: () => () => {}, dispose } } }))
  return { value, contexts, dispose }
}

describe("client integration host", () => {
  it("activates for an enabled, granted plugin with release provenance, without a panel", async () => {
    const { value, contexts } = host()
    value.sync(state([plugin()], ["cogpit.saved-drafts"], false)); await flush()
    expect(value.drafts("cogpit.saved-drafts")).not.toBeNull()
    expect(contexts[0]).toMatchObject({ pluginId: "cogpit.saved-drafts" })
  })
  it.each([
    ["not privileged", [plugin()], [], false],
    ["disabled", [plugin({ enabled: false })], ["cogpit.saved-drafts"], false],
    ["not granted", [plugin({ composer: ["append"] })], ["cogpit.saved-drafts"], false],
    ["browser safe mode", [plugin()], ["cogpit.saved-drafts"], true],
  ] as const)("stays inactive when %s", async (_name, plugins, privileged, safeMode) => {
    const { value, contexts } = host()
    value.sync(state([...plugins], [...privileged], safeMode)); await flush()
    expect(value.drafts("cogpit.saved-drafts")).toBeNull()
    expect(contexts).toHaveLength(0)
  })
  it("disposes on disable or a new package and aborts the context", async () => {
    const { value, contexts, dispose } = host()
    value.sync(state([plugin()], ["cogpit.saved-drafts"], false)); await flush()
    value.sync(state([plugin({ enabled: false })], ["cogpit.saved-drafts"], false))
    expect(dispose).toHaveBeenCalledOnce()
    expect(contexts[0].signal.aborted).toBe(true)
    value.sync(state([plugin({ digest: "b".repeat(64) })], ["cogpit.saved-drafts"], false)); await flush()
    value.sync(state([plugin({ digest: "c".repeat(64) })], ["cogpit.saved-drafts"], false)); await flush()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(value.drafts("cogpit.saved-drafts")).not.toBeNull()
  })
  it("limits a project-scoped plugin to its projects and stops answering once disabled", async () => {
    const { value, contexts } = host()
    value.sync(state([plugin({ projectIds: [projects[0].id] })])); await flush()
    expect(contexts[0].inScope("/work/one/src")).toBe(true)
    expect(contexts[0].inScope("/work/two")).toBe(false)
    expect(contexts[0].inScope(null)).toBe(false)
    value.sync(state([plugin({ enabled: false, projectIds: [projects[0].id] })]))
    expect(contexts[0].inScope("/work/one")).toBe(false)
  })
  it("never activates a module whose plugin was disabled while it loaded", async () => {
    const { value, contexts } = host()
    value.sync(state([plugin()], ["cogpit.saved-drafts"], false))
    value.sync(state([], [], false)); await flush()
    expect(contexts).toHaveLength(0)
  })
})
