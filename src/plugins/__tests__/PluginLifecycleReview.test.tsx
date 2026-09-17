import { useSyncExternalStore } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseConnectionDefinition, parseManifest } from "@cogpit/plugin-contracts"
import { authFetch } from "@/lib/auth"
import { __resetDeviceRevisionsForTest, __resetIdentityForTest } from "@/lib/device"
import { PluginsDialog } from "../PluginsDialog"
import { PluginInstallReview } from "../PluginInstallReview"
import { RuntimePluginClient } from "../runtimeClient"
import type { InstalledPlugin, PluginInstallPreview } from "../../../shared/contracts/plugins"
import type { PluginHostStatus } from "../../../shared/contracts/pluginManagement"
import { panelManifest, panelProject } from "./runtimePanelFixtures"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("../browserSupport", () => ({ getPluginBrowserSupport: () => ({ supported: true, browser: ["message-channel", "blob-script", "web-crypto"], missing: [], error: null }) }))
vi.mock("../PluginInstallTrial", () => ({ PluginInstallTrial: () => <p>Fixture trial started</p> }))

const manifest = parseManifest({ ...panelManifest, engines: { client: "*", host: "*", pluginApi: "^1.0.0" } })
const retained = parseManifest({ ...manifest, version: "0.9.0" })
function installed(): InstalledPlugin {
  return { id: manifest.id, manifest, selectedDigest: "a".repeat(64), pinned: false, enabled: true, scope: { type: "projects", projectIds: [panelProject.id] }, versions: [
    { manifest, digest: "a".repeat(64), targetPath: "current.json", installedAt: 2 },
    { manifest: retained, digest: "b".repeat(64), targetPath: "previous.json", installedAt: 1 },
  ] }
}
function candidate(): PluginInstallPreview {
  return { transactionId: "0743cefc-34a4-432f-a9d2-d887bb480af2", manifest: parseManifest({ ...manifest, version: "1.1.0" }), digest: "c".repeat(64), compatibility: { compatible: true, apiVersion: "1.0.0", issues: [], unavailableOptional: [] }, oldVersion: "1.0.0", registryRevision: 7, publisherKind: "official", scope: installed().scope, connectionDefinitions: [], operation: "update", previousManifest: manifest, previousConnectionDefinitions: [] }
}
function hostStatus(plugin = installed()): PluginHostStatus {
  return {
    runtime: { appVersion: "2.7.0", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "linux", registryRevision: 7 },
    host: { name: "Remote workstation", instanceId: "remote-fixture" }, safeMode: false, connectionRevision: 11,
    projects: [panelProject], store: { available: true, revision: 7, publishers: [], plugins: [plugin] },
  }
}
interface RequestRecord { path: string; method: string; body: unknown; headers: Headers }
let requests: RequestRecord[]
let status: PluginHostStatus
let staged: PluginInstallPreview
const clients: RuntimePluginClient[] = []
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })
function ConnectedDialog({ client }: { client: RuntimePluginClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  return <PluginsDialog client={client} state={state} currentPath={panelProject.paths[0]} onClose={() => {}} />
}
async function setup() {
  const client = new RuntimePluginClient()
  clients.push(client)
  client.start()
  await client.refresh()
  expect(client.getSnapshot().error).toBeNull()
  render(<ConnectedDialog client={client} />)
  return client
}
function removals() { return requests.filter(request => request.method === "DELETE" && request.path.includes("/installed/")) }
async function confirmRemoval() {
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }))
  return screen.findByRole("alertdialog", { name: "Uninstall Sample?" })
}
function previousVersions() { fireEvent.click(screen.getByText("Projects and previous versions")) }
async function submitUpdate() {
  fireEvent.click(screen.getByRole("button", { name: "Update from file" }))
  const field = screen.getByLabelText("Signed plugin package")
  fireEvent.change(field, { target: { files: [new File(["signed fixture"], "update.cogpit-plugin")] } })
  fireEvent.submit(field.closest("form")!)
}

beforeEach(() => {
  window.history.replaceState({}, "", "/d/remote-host/")
  __resetIdentityForTest(); __resetDeviceRevisionsForTest()
  requests = []; status = hostStatus(); staged = candidate()
  vi.mocked(authFetch).mockReset().mockImplementation(async (input, init) => {
    const request = { path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, headers: new Headers(init?.headers) }
    requests.push(request)
    if (request.path.endsWith("/session")) return json(request.method === "DELETE" ? { ok: true } : { sessionId: "d".repeat(64), expiresAt: Date.now() + 60_000 })
    if (request.path.endsWith("/status")) return json(status)
    if (request.method === "DELETE" && request.path.includes("/installed/")) {
      status = { ...status, store: { ...status.store, revision: 8, plugins: [] } }
      return json(status.store)
    }
    if (request.path.endsWith("/stage") || request.path.endsWith("/stage-seed") || request.path.endsWith("/rollback")) return json(staged)
    if (request.method === "DELETE" && request.path.includes("/transactions/")) return json({ ok: true })
    throw new Error(`Unexpected fixture request ${request.method} ${request.path}`)
  })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.stop()
  vi.restoreAllMocks()
  __resetIdentityForTest(); __resetDeviceRevisionsForTest()
  window.history.replaceState({}, "", "/")
})

describe("installed plugin lifecycle review", () => {
  it("retains settings by default and sends an authenticated DELETE to the selected host", async () => {
    await setup()
    const dialog = within(await confirmRemoval())
    expect(dialog.getByRole("checkbox", { name: "Delete my saved settings and connections on this host" })).not.toBeChecked()
    expect(removals()).toEqual([])
    fireEvent.click(dialog.getByRole("button", { name: "Uninstall from Remote workstation" }))
    await waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toMatchObject({ path: "/hub/remote-host/api/plugins/installed/example.sample", body: { deleteData: false, expectedRevision: 7 } })
    expect(removals()[0].headers.get("X-Cogpit-Plugin-Session")).toBe("d".repeat(64))
  })

  it("includes the connection revision only after explicit saved-data deletion is chosen", async () => {
    await setup()
    const dialog = within(await confirmRemoval())
    fireEvent.click(dialog.getByRole("checkbox", { name: "Delete my saved settings and connections on this host" }))
    expect(dialog.getByText(/Other administrators' saved data is retained/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole("button", { name: "Uninstall from Remote workstation" }))
    await waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0].body).toEqual({ deleteData: true, expectedConnectionRevision: 11, expectedRevision: 7 })
  })

  it("cancels without mutation and resets deletion consent when reopened", async () => {
    await setup()
    let dialog = within(await confirmRemoval())
    fireEvent.click(dialog.getByRole("checkbox", { name: "Delete my saved settings and connections on this host" }))
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(removals()).toEqual([])
    dialog = within(await confirmRemoval())
    expect(dialog.getByRole("checkbox", { name: "Delete my saved settings and connections on this host" })).not.toBeChecked()
    expect(removals()).toEqual([])
  })

  it("does not offer data deletion without a known connection revision", async () => {
    delete status.connectionRevision
    await setup()
    const dialog = within(await confirmRemoval())
    const deletion = dialog.getByRole("checkbox", { name: "Delete my saved settings and connections on this host" })
    expect(deletion).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(deletion)
    expect(deletion).not.toBeChecked()
    expect(dialog.getByRole("button", { name: "Uninstall from Remote workstation" })).toBeEnabled()
  })

  it("blocks updating and rollback while pinned but retains disable and uninstall controls", async () => {
    status.store.plugins[0].pinned = true
    await setup()
    expect(screen.getByRole("button", { name: "Update from file" })).toBeDisabled()
    previousVersions()
    expect(screen.getByRole("button", { name: "Review rollback to 0.9.0" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Unpin version" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled()
  })

  it("allows compatible retained versions while blocking incompatible and quarantined ones", async () => {
    status.store.plugins[0].lastError = "The selected package requires recovery"
    status.store.plugins[0].versions.push(
      { digest: "e".repeat(64), installedAt: 1, targetPath: "incompatible.json", manifest: parseManifest({ ...manifest, version: "0.8.0", engines: { ...manifest.engines, client: "^999.0.0" } }) },
      { digest: "f".repeat(64), installedAt: 1, targetPath: "quarantined.json", manifest: parseManifest({ ...manifest, version: "0.7.0" }), unavailableReason: "Package integrity verification failed" },
    )
    await setup()
    previousVersions()
    expect(screen.getByRole("button", { name: "Review rollback to 0.9.0" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Review rollback to 0.8.0" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Review rollback to 0.7.0" })).toBeDisabled()
    expect(screen.getByText("Package integrity verification failed")).toBeInTheDocument()
  })

  it("reviews an exact bundled repair with the installed scope without unpinning or enabling it", async () => {
    const plugin = status.store.plugins[0]
    Object.assign(plugin, { lastError: "Package integrity verification failed", pinned: true, enabled: false, scope: { type: "all" } })
    status.store.availableSeeds = [{ manifest, digest: plugin.selectedDigest }]
    staged = { ...staged, manifest, digest: plugin.selectedDigest, scope: plugin.scope }
    const client = await setup()
    const repair = screen.getByRole("button", { name: "Review bundled repair" })
    expect(repair).toBeEnabled()
    fireEvent.click(repair)
    expect(await screen.findByRole("heading", { name: "Sample 1.0.0" })).toBeInTheDocument()
    const mutations = requests.filter(request => request.method !== "GET" && !request.path.endsWith("/session"))
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ method: "POST", path: "/hub/remote-host/api/plugins/stage-seed", body: { pluginId: manifest.id, scope: { type: "all" }, client: expect.any(Object) } })
    expect(client.getSnapshot().status!.store.plugins[0]).toMatchObject({ pinned: true, enabled: false, selectedDigest: plugin.selectedDigest, scope: { type: "all" } })
    expect(screen.queryByText("Fixture trial started")).not.toBeInTheDocument()
  })

  it("does not offer bundled repair when the bundle has a different digest", async () => {
    status.store.plugins[0].lastError = "Package integrity verification failed"
    status.store.availableSeeds = [{ manifest, digest: "f".repeat(64) }]
    await setup()
    expect(screen.getByText("Needs recovery")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review bundled repair" })).not.toBeInTheDocument()
    expect(requests.filter(request => request.path.endsWith("/stage-seed"))).toEqual([])
  })

  it("keeps row updates bound to the installed plugin and cancels a different candidate", async () => {
    staged = { ...staged, manifest: parseManifest({ ...manifest, id: "example.other", name: "Another plugin" }) }
    await setup()
    await submitUpdate()
    expect(await screen.findByText("Choose a package for Sample (example.sample).")).toBeInTheDocument()
    expect(requests.filter(request => request.method === "DELETE" && request.path.includes("/transactions/"))).toHaveLength(1)
    expect(screen.queryByRole("heading", { name: "Another plugin 1.0.0" })).not.toBeInTheDocument()
    expect(screen.queryByText("Fixture trial started")).not.toBeInTheDocument()
    expect(requests.find(request => request.path.endsWith("/stage"))!.headers.get("X-Cogpit-Plugin-Scope")).toBe(JSON.stringify(installed().scope))
  })

  it("labels a valid row update and waits for review before starting its trial", async () => {
    await setup()
    await submitUpdate()
    expect(await screen.findByRole("heading", { name: "Sample 1.1.0" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Update on Remote workstation" })).toBeEnabled()
    expect(screen.queryByText("Fixture trial started")).not.toBeInTheDocument()
  })

  it("reviews rollback using current saved settings before starting a frame", async () => {
    staged = { ...staged, manifest: retained, operation: "rollback" }
    await setup()
    previousVersions()
    fireEvent.click(screen.getByRole("button", { name: "Review rollback to 0.9.0" }))
    expect(await screen.findByText("Rollback keeps current settings")).toBeInTheDocument()
    expect(screen.getByText(/Saved settings and connections are retained/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Roll back on Remote workstation" })).toBeEnabled()
    expect(screen.queryByText("Fixture trial started")).not.toBeInTheDocument()
  })

  it("pauses and resumes this browser without replacing unrelated URL parameters or history state", async () => {
    window.history.replaceState({ navigation: "retained" }, "", "/d/remote-host/?view=panels&filter=open#selected")
    await setup()
    fireEvent.click(screen.getByRole("button", { name: "Pause plugins in this browser" }))
    expect(window.location.search).toContain("pluginSafeMode=1")
    expect(screen.getByText("Plugin safe mode")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume plugins in this browser" }))
    expect(new URLSearchParams(window.location.search).has("pluginSafeMode")).toBe(false)
    expect(new URLSearchParams(window.location.search).get("view")).toBe("panels")
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("open")
    expect(window.location.hash).toBe("#selected")
    expect(window.history.state).toEqual({ navigation: "retained" })
    expect(screen.queryByText("Plugin safe mode")).not.toBeInTheDocument()
  })

  it("cannot resume a host-level safe mode from browser controls", async () => {
    status.safeMode = true
    window.history.replaceState({}, "", "/d/remote-host/?pluginSafeMode=1&view=panels")
    await setup()
    expect(screen.getByRole("button", { name: "Resume plugins in this browser" })).toBeDisabled()
    expect(screen.getByText(/host owner must restart Cogpit/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled()
  })
})

describe("package access changes", () => {
  it("explains native CLI reads and related Cogpit session access as separate permissions", () => {
    const next = parseManifest({ ...manifest, permissions: {
      navigation: ["external", "session"],
      integrations: [
        { id: "github", operations: ["actions", "actionJobs", "pulls", "pullFiles", "issues", "pullSessions"] },
        { id: "vercel", operations: ["deployments", "buildLogs"] },
      ],
    } })
    const cloudflare = parseManifest({ ...manifest, permissions: { integrations: [{ id: "cloudflare", operations: ["workspace", "deployments", "version"] }] } })
    const { unmount } = render(<PluginInstallReview preview={{ ...candidate(), manifest: cloudflare, oldVersion: null, previousManifest: undefined, operation: "install" }} />)
    for (const operation of ["Worker configuration and account", "deployments", "version details"]) {
      expect(screen.getByText(`Read Cloudflare ${operation} using this host's signed-in CLI`)).toBeInTheDocument()
    }
    unmount()
    render(<PluginInstallReview preview={{ ...candidate(), manifest: next, oldVersion: null, previousManifest: undefined, operation: "install" }} />)
    const requested = within(screen.getByRole("list"))
    for (const operation of ["workflow runs", "workflow jobs and steps", "pull requests", "pull request files", "issues"]) {
      expect(requested.getByText(`Read GitHub ${operation} using this host's signed-in CLI`)).toBeInTheDocument()
    }
    for (const operation of ["deployments", "build logs"]) {
      expect(requested.getByText(`Read Vercel ${operation} using this host's signed-in CLI`)).toBeInTheDocument()
    }
    const sessionRead = requested.getByText("Read related Cogpit sessions for the selected GitHub repository")
    expect(sessionRead).not.toHaveTextContent("CLI")
    expect(requested.getByText("Open permitted sessions")).not.toBe(sessionRead)
    expect(requested.getByText("Ask Cogpit to open HTTPS links")).toBeInTheDocument()
    expect(requested.getAllByRole("listitem")).toHaveLength(10)
  })
  it("highlights newly added native/session access and removed reads during update review", () => {
    const previous = parseManifest({ ...manifest, permissions: { integrations: [
      { id: "github", operations: ["actions"] }, { id: "vercel", operations: ["buildLogs"] },
    ] } })
    const next = parseManifest({ ...manifest, version: "1.1.0", permissions: { navigation: ["session"], integrations: [
      { id: "github", operations: ["actions", "pullSessions"] }, { id: "vercel", operations: ["deployments"] },
    ] } })
    render(<PluginInstallReview preview={{ ...candidate(), manifest: next, previousManifest: previous }} />)
    expect(screen.getByText("Added: Read related Cogpit sessions for the selected GitHub repository")).toBeInTheDocument()
    expect(screen.getByText("Added: Open permitted sessions")).toBeInTheDocument()
    expect(screen.getByText("Added: Read Vercel deployments using this host's signed-in CLI")).toBeInTheDocument()
    expect(screen.getByText("Removed: Read Vercel build logs using this host's signed-in CLI")).toBeInTheDocument()
    expect(screen.queryByText("Added: Read GitHub workflow runs using this host's signed-in CLI")).not.toBeInTheDocument()
  })
  it("shows added and removed access, changed credential destinations and affected clients", () => {
    const connection = (origin: string) => parseConnectionDefinition({ version: 1, id: "service", label: "Example account", secret: { id: "token", label: "Token" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", resources: {}, operations: { validate: { audience: "setup", origin, method: "GET", path: [{ literal: "account" }], args: {}, query: {} }, read: { audience: "panel", origin, method: "GET", path: [{ literal: "items" }], args: {}, query: {} } } })
    const access = [{ id: "service", definition: "connection.json", operations: ["read"] }]
    const previous = parseManifest({ ...manifest, permissions: { context: ["project.identity"], connections: access } })
    const next = parseManifest({ ...manifest, version: "1.1.0", permissions: { composer: ["append"], connections: access } })
    render(<PluginInstallReview preview={{ ...candidate(), manifest: next, previousManifest: previous, previousConnectionDefinitions: [connection("https://old.example.com")], connectionDefinitions: [connection("https://new.example.com")], incompatibleClients: ["Cogpit 2.4 · API 1.0"] }} />)
    expect(screen.getByText("Added: Append text to your draft message")).toBeInTheDocument()
    expect(screen.getByText("Removed: Read the selected project's name and plugin identifier")).toBeInTheDocument()
    expect(screen.getByText(/Changed connection: Example account/)).toBeInTheDocument()
    expect(screen.getByText("Credential destinations: https://new.example.com")).toBeInTheDocument()
    expect(screen.getByText("Some connected clients cannot run this version")).toBeInTheDocument()
    expect(screen.getByText(/Cogpit 2.4 · API 1.0/)).toBeInTheDocument()
  })
})
