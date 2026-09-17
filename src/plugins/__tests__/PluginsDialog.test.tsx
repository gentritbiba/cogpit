import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseManifest } from "@cogpit/plugin-contracts"
import { PluginsDialog } from "../PluginsDialog"
import type { RuntimePluginClient, RuntimePluginState } from "../runtimeClient"
import type { PluginInstallPreview } from "../../../shared/contracts/plugins"

vi.mock("../PluginInstallTrial", () => ({ PluginInstallTrial: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>Complete fixture trial</button> }))

const manifest = parseManifest({ manifestVersion: 1, id: "dev-test.sample", publisher: "dev-test", name: "Sample panel", version: "1.0.0", runtime: "browser-iife-v1", entry: "index.js", engines: { pluginApi: "^1.0.0", host: "*", client: "*" }, requires: { client: {}, host: {} }, contributes: { panels: [{ id: "main", title: "Sample", icon: "icon.png", when: "always" }] }, permissions: {}, stateVersion: 1 })
const preview: PluginInstallPreview = { transactionId: "0743cefc-34a4-432f-a9d2-d887bb480af2", manifest, digest: "a".repeat(64), compatibility: { compatible: true, apiVersion: "1.0.0", issues: [], unavailableOptional: [] }, connectionDefinitions: [], oldVersion: null, registryRevision: 1, publisherKind: "development", scope: { type: "projects", projectIds: [] } }
function setup(overrides: Partial<RuntimePluginState> = {}) {
  const client = { stageSeed: vi.fn().mockResolvedValue(preview), stage: vi.fn().mockResolvedValue(preview), cancel: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined), changeInstalled: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(preview), enrollDeveloper: vi.fn().mockResolvedValue(undefined) }
  const state: RuntimePluginState = { activation: "host-session", error: null, status: { runtime: { appVersion: "2.6.6", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "linux", registryRevision: 1 }, host: { name: "Remote workstation", instanceId: "fixture-host" }, safeMode: false, projects: [{ id: `p_${"a".repeat(40)}`, name: "Example", paths: ["/example"] }], store: { available: true, revision: 1, publishers: [], plugins: [] } }, ...overrides }
  const onClose = vi.fn()
  const view = render(<PluginsDialog client={client as unknown as RuntimePluginClient} state={state} currentPath={null} onClose={onClose} />)
  const update = (next: RuntimePluginState) => view.rerender(<PluginsDialog client={client as unknown as RuntimePluginClient} state={next} currentPath={null} onClose={onClose} />)
  return { client, state, onClose, update }
}
async function upload() {
  fireEvent.click(screen.getByRole("tab", { name: "Install from file" }))
  fireEvent.change(screen.getByLabelText("Signed plugin package"), { target: { files: [new File(["signed fixture"], "sample.cogpit-plugin")] } })
  expect(screen.getByRole("button", { name: "Review installation on Remote workstation" })).toBeEnabled()
  fireEvent.submit(screen.getByLabelText("Signed plugin package").closest("form")!)
  await screen.findByRole("heading", { name: "Sample panel 1.0.0" })
}
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/") })

describe("plugin installation controls", () => {
  it("shows the selected host and keeps an unselected workspace hidden until a project is chosen", async () => {
    const { client } = setup()
    expect(screen.getByText(/Installed on Remote workstation/)).toBeInTheDocument()
    await upload()
    expect(client.stage).toHaveBeenCalledWith(expect.any(File), { type: "projects", projectIds: [] })
    expect(screen.getByText("Development publisher")).toBeInTheDocument()
    expect(screen.getByText(/No project, connection, storage/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Complete fixture trial" })).not.toBeInTheDocument()
  })
  it("reviews a bundled package without installing it by default", async () => {
    const { client, state, update } = setup()
    update({ ...state, status: { ...state.status!, store: { ...state.status!.store, availableSeeds: [{ manifest, digest: preview.digest }] } } })
    expect(client.stageSeed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }))
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }))
    await screen.findByRole("heading", { name: "Sample panel 1.0.0" })
    expect(client.stageSeed).toHaveBeenCalledExactlyOnceWith(manifest.id, { type: "projects", projectIds: [] })
    expect(client.stage).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Complete fixture trial" })).not.toBeInTheDocument()
  })
  it("starts a provisional frame only after the permission review is accepted", async () => {
    setup()
    await upload()
    fireEvent.click(screen.getByRole("button", { name: "Install on Remote workstation" }))
    fireEvent.click(await screen.findByRole("button", { name: "Complete fixture trial" }))
    expect(await screen.findByText("Sample panel 1.0.0 is installed on Remote workstation.")).toBeInTheDocument()
  })
  it("reviews a newer bundled version with the installed project's access", async () => {
    const { client, state, update } = setup()
    const scope = { type: "all" as const }
    const newer = { ...manifest, version: "1.0.1" }
    client.stageSeed.mockResolvedValue({ ...preview, manifest: newer, oldVersion: "1.0.0", scope })
    update({ ...state, status: { ...state.status!, store: { ...state.status!.store,
      availableSeeds: [{ manifest: newer, digest: "b".repeat(64) }],
      plugins: [{ id: manifest.id, manifest, selectedDigest: preview.digest, enabled: false, pinned: false, scope, versions: [] }],
    } } })
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }))
    fireEvent.click(screen.getByRole("button", { name: "Review update" }))
    await screen.findByRole("heading", { name: "Sample panel 1.0.1" })
    expect(client.stageSeed).toHaveBeenCalledExactlyOnceWith(manifest.id, scope)
    expect(screen.getByText("Replaces 1.0.0 on Remote workstation")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Update on Remote workstation" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Complete fixture trial" })).not.toBeInTheDocument()
  })
  it.each(["1.0.0", "0.9.0"])("does not offer bundled version %s as an update to 1.0.0", (version) => {
    const { state, update } = setup()
    update({ ...state, status: { ...state.status!, store: { ...state.status!.store,
      availableSeeds: [{ manifest: { ...manifest, version }, digest: "b".repeat(64) }],
      plugins: [{ id: manifest.id, manifest, selectedDigest: preview.digest, enabled: true, pinned: false, scope: preview.scope, versions: [] }],
    } } })
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }))
    expect(screen.queryByRole("button", { name: "Review update" })).not.toBeInTheDocument()
  })
  it("requires unpinning before reviewing a bundled update", () => {
    const { state, update } = setup()
    update({ ...state, status: { ...state.status!, store: { ...state.status!.store,
      availableSeeds: [{ manifest: { ...manifest, version: "1.0.1" }, digest: "b".repeat(64) }],
      plugins: [{ id: manifest.id, manifest, selectedDigest: preview.digest, enabled: true, pinned: true, scope: preview.scope, versions: [] }],
    } } })
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }))
    expect(screen.getByRole("button", { name: "Pinned to installed version" })).toBeDisabled()
  })
  it("cancels a prepared candidate without changing an installed version", async () => {
    const { client } = setup()
    await upload()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(preview))
    expect(client.changeInstalled).not.toHaveBeenCalled()
  })
  it("explains incompatible versions and prevents activation", async () => {
    const { client } = setup()
    client.stage.mockResolvedValue({ ...preview, compatibility: { ...preview.compatibility, compatible: false, issues: [{ side: "host", code: "API_VERSION", name: "pluginApi", required: "^2.0.0", actual: "1.0.0" }] } })
    await upload()
    expect(screen.getByText(/pluginApi requires \^2.0.0/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Install on Remote workstation" })).toBeDisabled()
  })
  it("keeps the manager usable while safe mode blocks installation trials", async () => {
    window.history.replaceState({}, "", "/?pluginSafeMode=1")
    setup()
    await upload()
    expect(screen.getByText("Plugin safe mode")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Install on Remote workstation" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
  })
  it("keeps an unsupported host error inside the manager", () => {
    setup({ status: null, error: "This host does not support runtime plugins" })
    expect(screen.getByText("This host does not support runtime plugins")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled()
  })
  it("stops a provisional frame immediately when the host activation is lost", async () => {
    const { client, state, update } = setup()
    await upload()
    fireEvent.click(screen.getByRole("button", { name: "Install on Remote workstation" }))
    expect(screen.getByRole("button", { name: "Complete fixture trial" })).toBeInTheDocument()
    update({ ...state, status: null, activation: "", error: "Host disconnected" })
    expect(screen.queryByRole("button", { name: "Complete fixture trial" })).not.toBeInTheDocument()
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(preview))
  })
  it("stops a running trial when the host enters safe mode", async () => {
    const { state, update } = setup()
    await upload()
    fireEvent.click(screen.getByRole("button", { name: "Install on Remote workstation" }))
    update({ ...state, status: { ...state.status!, safeMode: true } })
    expect(screen.queryByRole("button", { name: "Complete fixture trial" })).not.toBeInTheDocument()
    expect(screen.getByText("Plugin safe mode")).toBeInTheDocument()
  })
})
