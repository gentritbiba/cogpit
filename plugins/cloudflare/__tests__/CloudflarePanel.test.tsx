import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CloudflareDeploymentsResponse, CloudflareVersionResponse, CloudflareWorkspace } from "@cogpit/plugin-integrations"
import type { AccountStore } from "../accountStore"

const storeMocks = vi.hoisted(() => ({ useCloudflare: vi.fn(), fetchVersion: vi.fn(), refresh: vi.fn() }))
const accountMocks = vi.hoisted(() => ({ useAccountWorkers: vi.fn(), refresh: vi.fn() }))
vi.mock("../cloudflareStore", () => storeMocks)
vi.mock("../accountStore", () => accountMocks)

import { CloudflarePanel, configLabel, deploymentTitle } from "../CloudflarePanel"

const VERSION_ID = "a5d6631d-f96f-4917-bec2-5a31678c58fe"
const OLDER_VERSION_ID = "616630a4-2edd-4ceb-8e19-100361abda6e"
const workspace: CloudflareWorkspace = {
  workerName: "tenant-router", configPath: "apps/api/wrangler.toml", configs: ["apps/api/wrangler.toml"],
  environments: [
    { name: null, workerName: "tenant-router", routes: ["example.com/*"], crons: ["0 * * * *"], bindings: [{ name: "TENANT_MAP", type: "kv_namespaces", target: null }, { name: "DB", type: "d1_databases", target: "tenants" }], compatibilityDate: "2024-01-01", dashboardUrl: "https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router/production" },
    { name: "staging", workerName: "tenant-router-staging", routes: ["staging.example.com/*"], crons: [], bindings: [], compatibilityDate: "2025-01-01", dashboardUrl: "https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router-staging/production" },
  ],
  email: "dev@example.com", account: { id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev account" },
}
const deployments: CloudflareDeploymentsResponse = {
  workerName: "tenant-router", environment: null,
  deployments: [
    { id: "newer", createdAt: new Date(Date.now() - 120_000).toISOString(), source: "wrangler", strategy: "percentage", author: "dev@example.com", message: "PR 167 preserve browser policy", triggeredBy: "deployment", versions: [{ id: VERSION_ID, percentage: 100 }] },
    { id: "secret", createdAt: new Date(Date.now() - 3_600_000).toISOString(), source: "wrangler", strategy: "percentage", author: "dev@example.com", message: null, triggeredBy: "secret", versions: [{ id: OLDER_VERSION_ID, percentage: 100 }] },
  ],
}
const version: CloudflareVersionResponse = { version: {
  id: VERSION_ID, number: 22, createdAt: deployments.deployments[0].createdAt, source: "wrangler", author: "dev@example.com", message: "PR 167 preserve browser policy", tag: "d627fd89465561586c95f63c2c3fea8447dc08c2", triggeredBy: "version_upload", hasPreview: true,
  compatibilityDate: "2024-01-01", compatibilityFlags: ["brotli_content_encoding"], handlers: ["fetch"], usageModel: "standard",
  bindings: [{ name: "ORIGIN_SECRET", type: "secret_text" }, { name: "TENANT_MAP", type: "kv_namespace" }],
} }
const openExternal = vi.fn().mockResolvedValue(undefined)
const account = { load: vi.fn(), subscribe: vi.fn(), snapshot: vi.fn(), dispose: vi.fn() } as unknown as AccountStore
function mockState(state: Partial<ReturnType<typeof storeMocks.useCloudflare>>) {
  storeMocks.useCloudflare.mockReturnValue({ workspace: null, deployments: null, error: null, loading: false, refreshing: false, refresh: storeMocks.refresh, fetchVersion: storeMocks.fetchVersion, ...state })
}
function mockAccount(state: Partial<ReturnType<typeof accountMocks.useAccountWorkers>>) {
  accountMocks.useAccountWorkers.mockReturnValue({ account: null, workers: null, error: null, loading: false, refreshing: false, refresh: accountMocks.refresh, ...state })
}
function renderPanel(store: AccountStore | null = account) {
  return render(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={store} />)
}
beforeEach(() => { vi.clearAllMocks(); storeMocks.fetchVersion.mockResolvedValue(version); mockAccount({}) })

describe("labels", () => {
  it("names deployments and configurations", () => {
    expect(deploymentTitle({ ...deployments.deployments[0], message: "First line\nSecond" })).toBe("First line")
    expect(deploymentTitle(deployments.deployments[1])).toBe("Secrets updated")
    expect(deploymentTitle({ ...deployments.deployments[1], triggeredBy: "rollback" })).toBe("Rolled back")
    expect(deploymentTitle({ ...deployments.deployments[1], triggeredBy: null })).toBe("Deployment")
    expect(configLabel("wrangler.toml")).toBe("root")
    expect(configLabel("services/router/wrangler.jsonc")).toBe("services/router")
  })
})

describe("CloudflarePanel workspace view", () => {
  it("shows the live deployment, account, configuration and a dashboard link", async () => {
    mockState({ workspace, deployments })
    renderPanel()
    expect(storeMocks.useCloudflare).toHaveBeenCalledWith("/repo", null, null, true)
    expect(screen.getByLabelText("Signed-in account")).toHaveTextContent("dev@example.com · Dev account")
    const live = screen.getByLabelText("Live deployment")
    expect(within(live).getByText("PR 167 preserve browser policy")).toBeInTheDocument()
    expect(within(live).getByText("a5d6631d")).toBeInTheDocument()
    const configuration = screen.getByLabelText("Configuration")
    expect(configuration).toHaveTextContent("apps/api/wrangler.toml")
    expect(configuration).toHaveTextContent("example.com/*")
    expect(configuration).toHaveTextContent("0 * * * *")
    expect(within(configuration).getByText("DB")).toBeInTheDocument()
    expect(within(configuration).getByText("tenants")).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Worker" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("link", { name: "tenant-router" }))
    expect(openExternal).toHaveBeenCalledWith(workspace.environments[0].dashboardUrl)
  })

  it("offers a Worker picker when the workspace holds several configurations and resets the environment on switch", async () => {
    mockState({ workspace: { ...workspace, configs: ["apps/api/wrangler.toml", "services/router/wrangler.jsonc"] }, deployments })
    const { rerender } = renderPanel()
    await userEvent.click(screen.getByRole("button", { name: "staging" }))
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(storeMocks.useCloudflare).toHaveBeenLastCalledWith("/repo", null, "staging", true)
    const picker = screen.getByRole("group", { name: "Worker" })
    expect(within(picker).getByRole("button", { name: "apps/api" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(within(picker).getByRole("button", { name: "services/router" }))
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(storeMocks.useCloudflare).toHaveBeenLastCalledWith("/repo", "services/router/wrangler.jsonc", null, true)
    mockState({ workspace: null, deployments: null, loading: true })
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    const stillThere = screen.getByRole("group", { name: "Worker" })
    expect(within(stillThere).getByRole("button", { name: "services/router" })).toHaveAttribute("aria-pressed", "true")
  })

  it("switches environments through the chips and shows that environment's configuration", async () => {
    mockState({ workspace, deployments })
    const { rerender } = renderPanel()
    await userEvent.click(screen.getByRole("button", { name: "staging" }))
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(storeMocks.useCloudflare).toHaveBeenLastCalledWith("/repo", null, "staging", true)
    expect(screen.getByRole("link", { name: "tenant-router-staging" })).toBeInTheDocument()
    expect(screen.getByLabelText("Configuration")).toHaveTextContent("tenant-router-staging")
    expect(screen.getByLabelText("Configuration")).toHaveTextContent("2025-01-01")
    expect(screen.getByLabelText("Configuration")).toHaveTextContent("No bindings declared for this environment.")
  })

  it("loads version details with bindings when a deployment is expanded", async () => {
    mockState({ workspace, deployments })
    renderPanel()
    expect(screen.getByRole("article", { name: "Secrets updated" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "PR 167 preserve browser policy" }))
    expect(storeMocks.fetchVersion).toHaveBeenCalledWith(VERSION_ID, expect.any(AbortSignal))
    const details = await screen.findByLabelText("Version a5d6631d")
    expect(details).toHaveTextContent("v22")
    expect(details).toHaveTextContent("d627fd894655")
    expect(details).toHaveTextContent("brotli_content_encoding")
    expect(within(details).getByText("ORIGIN_SECRET")).toBeInTheDocument()
    expect(within(details).getByText("secret_text")).toBeInTheDocument()
  })

  it("explains setup errors and keeps a gentle tone for a Worker that is not deployed yet", () => {
    mockState({ error: { error: "Sign in with `wrangler login`", code: "cloudflare_auth_required" } })
    const { rerender } = renderPanel()
    expect(screen.getByRole("alert")).toHaveTextContent("Run `wrangler login` on the Cogpit host")
    mockState({ workspace, error: { error: "Not deployed", code: "cloudflare_worker_missing" } })
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Deploy this Worker once with `wrangler deploy`")
    expect(screen.getByRole("alert")).not.toHaveAttribute("data-variant", "destructive")
  })

  it("shows the loading skeleton, an empty state and refreshes on demand", async () => {
    mockState({ loading: true })
    const { rerender } = renderPanel()
    expect(screen.getByLabelText("Loading Cloudflare deployments")).toBeInTheDocument()
    mockState({ workspace, deployments: { ...deployments, deployments: [] } })
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(screen.getByText("No deployments yet")).toBeInTheDocument()
    expect(screen.queryByLabelText("Live deployment")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Refresh Cloudflare deployments" }))
    expect(storeMocks.refresh).toHaveBeenCalled()
  })
})

describe("CloudflarePanel account view", () => {
  it("pauses the workspace reads while showing account Workers with dashboard links", async () => {
    mockState({ workspace, deployments })
    mockAccount({ account: { id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev account" }, workers: [
      { name: "tenant-router", createdAt: "2026-01-01T00:00:00Z", modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), handlers: ["fetch", "scheduled"], usageModel: "standard", lastDeployedFrom: "wrangler", dashboardUrl: "https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router/production" },
      { name: "vehicle-service", createdAt: null, modifiedAt: null, handlers: [], usageModel: null, lastDeployedFrom: null, dashboardUrl: null },
    ] })
    const { rerender } = renderPanel()
    await userEvent.click(screen.getByRole("tab", { name: "Account" }))
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(storeMocks.useCloudflare).toHaveBeenLastCalledWith("/repo", null, null, false)
    expect(accountMocks.useAccountWorkers).toHaveBeenLastCalledWith(account, true)
    expect(screen.getByLabelText("Connected account")).toHaveTextContent("Dev account")
    const list = screen.getByLabelText("Account Workers")
    expect(within(list).getAllByRole("article")).toHaveLength(2)
    expect(within(list).getByRole("article", { name: "tenant-router" })).toHaveTextContent("fetch, scheduled")
    await userEvent.click(within(list).getByRole("button", { name: "Open tenant-router on Cloudflare" }))
    expect(openExternal).toHaveBeenCalledWith("https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router/production")
    await userEvent.click(screen.getByRole("button", { name: "Refresh account Workers" }))
    expect(accountMocks.refresh).toHaveBeenCalled()
  })

  it("explains a missing token, an unselected account and an unavailable broker", async () => {
    mockState({ workspace, deployments })
    mockAccount({ error: { code: "cloudflare_not_connected", error: "Connect Cloudflare" } })
    const { rerender, unmount } = renderPanel()
    await userEvent.click(screen.getByRole("tab", { name: "Account" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Workers Scripts Read")
    mockAccount({ error: { code: "cloudflare_account_unselected", error: "Choose an account" } })
    rerender(<CloudflarePanel context={{ projectPath: "/repo" }} active openExternal={openExternal} account={account} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Pick the one to browse in Connections")
    unmount()
    renderPanel(null)
    await userEvent.click(screen.getByRole("tab", { name: "Account" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Account browsing is unavailable")
  })
})
