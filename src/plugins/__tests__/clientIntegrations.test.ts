// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ClientIntegrationHost, type ClientIntegrationContext } from "../clientIntegrations"
import type { InstalledPlugin } from "../../../shared/contracts/plugins"

function plugin(overrides: { enabled?: boolean; composer?: string[]; digest?: string } = {}): InstalledPlugin {
  return { id: "cogpit.saved-drafts", selectedDigest: overrides.digest ?? "a".repeat(64), enabled: overrides.enabled ?? true, scope: { type: "all" }, pinned: false, versions: [],
    manifest: { permissions: { composer: overrides.composer ?? ["drafts"] } } } as unknown as InstalledPlugin
}
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
    value.sync([plugin()], ["cogpit.saved-drafts"], false); await flush()
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
    value.sync(plugins, privileged, safeMode); await flush()
    expect(value.drafts("cogpit.saved-drafts")).toBeNull()
    expect(contexts).toHaveLength(0)
  })
  it("disposes on disable or a new package and aborts the context", async () => {
    const { value, contexts, dispose } = host()
    value.sync([plugin()], ["cogpit.saved-drafts"], false); await flush()
    value.sync([plugin({ enabled: false })], ["cogpit.saved-drafts"], false)
    expect(dispose).toHaveBeenCalledOnce()
    expect(contexts[0].signal.aborted).toBe(true)
    value.sync([plugin({ digest: "b".repeat(64) })], ["cogpit.saved-drafts"], false); await flush()
    value.sync([plugin({ digest: "c".repeat(64) })], ["cogpit.saved-drafts"], false); await flush()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(value.drafts("cogpit.saved-drafts")).not.toBeNull()
  })
  it("never activates a module whose plugin was disabled while it loaded", async () => {
    const { value, contexts } = host()
    value.sync([plugin()], ["cogpit.saved-drafts"], false)
    value.sync([], [], false); await flush()
    expect(contexts).toHaveLength(0)
  })
})
