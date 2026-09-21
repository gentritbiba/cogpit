import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowUpRight, Cloud, KeyRound, RefreshCw, Undo2, Upload, X } from "lucide-react"
import type {
  CloudflareAccountWorker,
  CloudflareDeployment,
  CloudflareEnvironment,
  CloudflareErrorResponse,
  CloudflareVersion,
  CloudflareVersionResponse,
  CloudflareWorkspace,
} from "@cogpit/plugin-integrations"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  FilterChip,
  relativeTime,
  ScrollArea,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useNow,
} from "@cogpit/plugin-ui"
import { useAccountWorkers, type AccountError, type AccountStore } from "./accountStore.js"
import { useCloudflare } from "./cloudflareStore.js"

export interface CloudflarePanelProps {
  context: { projectPath: string | null }
  active: boolean
  closePanel?: () => void
  openExternal: (url: string) => Promise<unknown>
  /** Account-wide reads through the host connection; `null` when the host offers no connection broker. */
  account: AccountStore | null
}
type FetchVersion = (versionId: string, signal?: AbortSignal) => Promise<CloudflareVersionResponse>
type View = "workspace" | "account"
const NavigationContext = createContext<CloudflarePanelProps["openExternal"]>(() => Promise.reject(new Error("Navigation is unavailable")))

const shortId = (id: string) => id.slice(0, 8)
const environmentLabel = (name: string | null) => name ?? "default"

/** The folder a configuration lives in, which is how people refer to Workers in a monorepo. */
export function configLabel(path: string): string {
  const folder = path.replace(/\/?wrangler\.(?:json|jsonc|toml)$/, "")
  return folder || "root"
}

/** The deploy message when one was given, otherwise what Wrangler recorded as the trigger. */
export function deploymentTitle(deployment: CloudflareDeployment): string {
  const message = deployment.message?.split("\n")[0].trim()
  if (message) return message
  if (deployment.triggeredBy === "secret") return "Secrets updated"
  if (deployment.triggeredBy === "rollback") return "Rolled back"
  return "Deployment"
}

/** Version ids a deployment serves, with their traffic share while a split is in progress. */
function VersionIds({ versions }: { versions: CloudflareDeployment["versions"] }) {
  return <>{versions.map((version) => (
    <span key={version.id} className="shrink-0">{shortId(version.id)}{versions.length > 1 && ` ${version.percentage}%`}</span>
  ))}</>
}

function TriggerGlyph({ triggeredBy, className }: { triggeredBy: string | null; className?: string }) {
  const size = cn("size-3.5 shrink-0 text-muted-foreground", className)
  if (triggeredBy === "secret") return <KeyRound className={size} aria-label="Secrets updated" />
  if (triggeredBy === "rollback") return <Undo2 className={size} aria-label="Rollback" />
  return <Upload className={size} aria-label="Deployment" />
}

function errorHelp(error: CloudflareErrorResponse): string {
  switch (error.code) {
    case "wrangler_missing": return "Install Wrangler in this project (`bun add -D wrangler`) or globally on the Cogpit host, then refresh."
    case "wrangler_too_old": return "Update Wrangler to 4.65.0 or newer, then refresh."
    case "cloudflare_auth_required": return "Run `wrangler login` on the Cogpit host, or set CLOUDFLARE_API_TOKEN for it, then refresh."
    case "cloudflare_account_required": return "Add account_id to the Wrangler configuration, or set CLOUDFLARE_ACCOUNT_ID on the Cogpit host, then refresh."
    case "cloudflare_config_missing": return "Add a wrangler.jsonc or wrangler.toml to this folder, its repository root or one of its subfolders. This panel checks again automatically."
    case "cloudflare_config_invalid": return "Fix the Wrangler configuration so `wrangler deploy` would accept it. This panel checks again automatically."
    case "cloudflare_worker_missing": return "Deploy this Worker once with `wrangler deploy`. This panel checks again automatically."
    case "cloudflare_pages_unsupported": return "This panel reads Workers deployments only. Pages projects are not supported yet."
    case "cloudflare_access_denied": return "Sign in to a Cloudflare account that can access this Worker."
    default: return "Check the Wrangler configuration and your Cloudflare access, then try again."
  }
}

function accountErrorHelp(error: AccountError): string {
  switch (error.code) {
    case "cloudflare_not_connected": return "Create an API token with Workers Scripts Read and Account Settings Read, then paste it in Connections. The token stays on the Cogpit host."
    case "cloudflare_account_unselected": return "The token can see several accounts. Pick the one to browse in Connections."
    default: return "Check the token's permissions and try again."
  }
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const openExternal = useContext(NavigationContext)
  const [error, setError] = useState<string | null>(null)
  return (
    <><button
      type="button"
      role="link"
      onClick={() => { setError(null); void openExternal(href).catch(failure => { if (failure?.code !== "CANCELED") setError("Unable to open this link") }) }}
      className={cn("inline-flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline", className)}
    >
      <span className="truncate">{children}</span>
      <ArrowUpRight className="size-3 shrink-0" />
    </button>{error && <span role="alert" className="text-xs text-destructive">{error}</span>}</>
  )
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4 px-3 py-4" aria-label={label}>
      <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex flex-col gap-2 border-l-2 border-border pl-3">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 text-[11px] leading-4">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-mono text-[10px] leading-4">{children}</dd>
    </div>
  )
}

function BindingList({ bindings, emptyText }: { bindings: readonly { name: string; type: string; target?: string | null }[]; emptyText: string }) {
  if (bindings.length === 0) return <p className="text-[11px] text-muted-foreground">{emptyText}</p>
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[10px] leading-4" aria-label="Bindings">
      {bindings.map((binding) => (
        <li key={`${binding.type}:${binding.name}`} className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-foreground/90">{binding.name}</span>
          <span className="shrink-0 text-muted-foreground">{binding.type}</span>
          {binding.target && <span className="min-w-0 truncate text-muted-foreground">{binding.target}</span>}
        </li>
      ))}
    </ul>
  )
}

function Configuration({ workspace, environment }: { workspace: CloudflareWorkspace; environment: CloudflareEnvironment }) {
  return (
    <section aria-label="Configuration" className="mx-3 mt-3 rounded-md border bg-card px-3 py-2.5">
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Configuration · {workspace.configPath}</p>
      <dl className="flex flex-col gap-1">
        <Fact label="Worker">{environment.workerName}</Fact>
        {environment.compatibilityDate && <Fact label="Compat">{environment.compatibilityDate}</Fact>}
        {environment.routes.length > 0 && <Fact label="Routes">{environment.routes.join(", ")}</Fact>}
        {environment.crons.length > 0 && <Fact label="Crons">{environment.crons.join(", ")}</Fact>}
      </dl>
      <div className="mt-2 border-t border-border/60 pt-2">
        <BindingList bindings={environment.bindings} emptyText="No bindings declared for this environment." />
      </div>
    </section>
  )
}

function LiveDeployment({ deployment, now }: { deployment: CloudflareDeployment; now: number }) {
  const title = deploymentTitle(deployment)
  return (
    <section aria-label="Live deployment" className="mx-3 mt-3 rounded-md border border-success/30 bg-success/[0.05] px-3 py-2.5">
      <p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        Live
        <span className="ml-auto normal-case tracking-normal tabular-nums">{relativeTime(deployment.createdAt, now)}</span>
      </p>
      <h3 className="truncate text-[13px] font-medium leading-5" title={title}>{title}</h3>
      <p className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <VersionIds versions={deployment.versions} />
        <span className="min-w-0 flex-1" />
        {deployment.author && <span className="min-w-0 truncate font-sans text-[11px]">by {deployment.author}</span>}
      </p>
    </section>
  )
}

interface VersionsState {
  versions: CloudflareVersion[] | null
  error: string | null
  loading: boolean
}
const EMPTY_VERSIONS: VersionsState = { versions: null, error: null, loading: false }

function VersionDetails({ version }: { version: CloudflareVersion }) {
  return (
    <div className="flex flex-col gap-1.5" aria-label={`Version ${shortId(version.id)}`}>
      <dl className="flex flex-col gap-1">
        <Fact label="Version">{version.number !== null ? `v${version.number} · ` : ""}{version.id}</Fact>
        {version.tag && <Fact label="Commit">{version.tag.slice(0, 12)}</Fact>}
        {version.compatibilityDate && <Fact label="Compat">{version.compatibilityDate}{version.compatibilityFlags.length > 0 && ` · ${version.compatibilityFlags.join(", ")}`}</Fact>}
        {version.handlers.length > 0 && <Fact label="Handlers">{version.handlers.join(", ")}</Fact>}
        {version.usageModel && <Fact label="Usage">{version.usageModel}</Fact>}
      </dl>
      <BindingList bindings={version.bindings} emptyText="This version has no bindings." />
    </div>
  )
}

function DeploymentRow({ deployment, rowKey, now, fetchVersion }: { deployment: CloudflareDeployment; rowKey: string; now: number; fetchVersion: FetchVersion }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<VersionsState>(EMPTY_VERSIONS)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [rowKey, fetchVersion])
  const title = deploymentTitle(deployment)

  async function loadVersions(): Promise<void> {
    if (state.loading) return
    const abort = new AbortController()
    pending.current = abort
    setState((current) => ({ ...current, error: null, loading: true }))
    try {
      const results = await Promise.all(deployment.versions.map((version) => fetchVersion(version.id, abort.signal)))
      if (abort.signal.aborted) return
      setState({ versions: results.map((result) => result.version), error: null, loading: false })
    } catch (error) {
      if (abort.signal.aborted) return
      const detail = error && typeof error === "object" ? error as Partial<CloudflareErrorResponse> : {}
      setState({ versions: null, error: typeof detail.error === "string" ? detail.error : "Unable to load version details", loading: false })
    }
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) { pending.current?.abort(); setState((current) => ({ ...current, loading: false })) }
    if (next && !state.versions && deployment.versions.length > 0) void loadVersions()
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <article className="group/deployment relative rounded-md bg-card py-2 pl-3 pr-2" aria-label={title}>
        <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", deployment.triggeredBy === "rollback" ? "bg-warning" : "bg-border")} />
        <CollapsibleTrigger
          className="flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
          aria-label={title}
          aria-expanded={open}
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <TriggerGlyph triggeredBy={deployment.triggeredBy} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
            <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{relativeTime(deployment.createdAt, now)}</span>
          </span>
          <span className="flex w-full min-w-0 items-center gap-2 pl-[22px] font-mono text-[10px] leading-4 text-muted-foreground">
            <VersionIds versions={deployment.versions} />
            {deployment.versions.length === 0 && <span>no version recorded</span>}
            <span className="min-w-0 flex-1" />
            {deployment.author && <span className="min-w-0 truncate">{deployment.author}</span>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-[7px] flex flex-col gap-3 border-l border-border py-2 pl-4 pr-1">
            <p className="text-[11px] text-muted-foreground">{deployment.source} · {deployment.strategy}{deployment.triggeredBy && ` · ${deployment.triggeredBy}`}</p>
            {state.loading && !state.versions && (
              <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground" role="status">
                <Spinner className="size-3" />
                Loading version details
              </div>
            )}
            {state.error && <p className="text-[11px] text-destructive">{state.error}</p>}
            {state.versions?.map((version) => <VersionDetails key={version.id} version={version} />)}
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

function WorkerRow({ worker, now }: { worker: CloudflareAccountWorker; now: number }) {
  const openExternal = useContext(NavigationContext)
  return (
    <article className="group/worker flex items-start gap-1 border-l-2 border-border pl-3" aria-label={worker.name}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
        <span className="flex w-full min-w-0 items-center gap-2">
          <Cloud className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{worker.name}</span>
          {worker.modifiedAt && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{relativeTime(worker.modifiedAt, now)}</span>}
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 pl-[22px] font-mono text-[10px] leading-4 text-muted-foreground">
          {worker.handlers.length > 0 && <span className="min-w-0 truncate">{worker.handlers.join(", ")}</span>}
          {worker.lastDeployedFrom && <span className="shrink-0">via {worker.lastDeployedFrom}</span>}
          {worker.usageModel && <span className="shrink-0">{worker.usageModel}</span>}
        </span>
      </div>
      {worker.dashboardUrl && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mt-0.5 size-6 text-muted-foreground opacity-0 transition-opacity group-hover/worker:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Open ${worker.name} on Cloudflare`}
          onClick={() => { void openExternal(worker.dashboardUrl!).catch(() => {}) }}
        >
          <ArrowUpRight />
        </Button>
      )}
    </article>
  )
}

function AccountWorkers({ store, state }: { store: AccountStore | null; state: ReturnType<typeof useAccountWorkers> }) {
  const { account, workers, error, loading } = state
  const now = useNow(false)
  if (!store) {
    return <Alert className="m-3 w-auto"><AlertTitle>Account browsing is unavailable</AlertTitle><AlertDescription>This host does not offer plugin connections.</AlertDescription></Alert>
  }
  return (
    <>
      {error && (
        <Alert variant={error.code === "cloudflare_api_failed" || error.code === "invalid_response" ? "destructive" : "default"} className="m-3 w-auto">
          <AlertTitle>{error.error}</AlertTitle>
          <AlertDescription>{accountErrorHelp(error)}</AlertDescription>
        </Alert>
      )}
      {loading && !workers && !error && <LoadingRows label="Loading account Workers" />}
      {workers && (
        <ScrollArea className="min-h-0 flex-1">
          {account && <p className="truncate px-4 pt-3 text-[11px] text-muted-foreground" aria-label="Connected account">{account.name}</p>}
          {workers.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Cloud /></EmptyMedia>
                <EmptyTitle>No Workers in this account</EmptyTitle>
                <EmptyDescription>Workers deployed to {account?.name ?? "this account"} will show up here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-3 px-3 py-3" aria-label="Account Workers">
              {workers.map((worker) => <WorkerRow key={worker.name} worker={worker} now={now} />)}
            </div>
          )}
        </ScrollArea>
      )}
    </>
  )
}

export function CloudflarePanel({ context, active, closePanel, openExternal, account }: CloudflarePanelProps) {
  const [view, setView] = useState<View>("workspace")
  const [config, setConfig] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<string | null>(null)
  const workspaceActive = active && view === "workspace"
  const { workspace, deployments, error, loading, refreshing, refresh, fetchVersion } = useCloudflare(context.projectPath, config, environment, workspaceActive)
  const accountState = useAccountWorkers(account, active && view === "account")
  const projectPath = context.projectPath
  const now = useNow(false)
  const environments = workspace?.environments ?? []
  const selected = environments.find((entry) => entry.name === environment) ?? environments[0] ?? null
  const rows = deployments?.deployments ?? []
  // Keep the picker mounted while another Worker's workspace is still loading.
  const knownConfigs = useRef<string[]>([])
  if (workspace) knownConfigs.current = workspace.configs
  const configs = workspace?.configs ?? knownConfigs.current
  const selectedConfig = config ?? workspace?.configPath ?? configs[0]
  const busy = view === "workspace" ? loading || refreshing : accountState.loading || accountState.refreshing

  return (
    <NavigationContext.Provider value={openExternal}><Tabs value={view} onValueChange={(value) => { if (value === "workspace" || value === "account") setView(value) }} className="size-full min-h-0 gap-0" aria-label="Cloudflare Workers panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">Cloudflare Workers</h2>
          {view === "account" ? (
            <p className="truncate text-[11px] text-muted-foreground">{accountState.account ? accountState.account.name : "Workers in the connected account"}</p>
          ) : selected?.dashboardUrl ? (
            <ExternalLink href={selected.dashboardUrl} className="max-w-full">{selected.workerName}</ExternalLink>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">{selected ? selected.workerName : "Workers for this workspace"}</p>
          )}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => { void (view === "workspace" ? refresh() : accountState.refresh()) }} disabled={busy || (view === "workspace" && !projectPath)} aria-label={view === "workspace" ? "Refresh Cloudflare deployments" : "Refresh account Workers"}>
          {busy ? <Spinner /> : <RefreshCw />}
        </Button>
        {closePanel && <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close Cloudflare Workers">
          <X />
        </Button>}
      </header>
      <div className="flex h-9 shrink-0 items-end border-b px-3"><TabsList variant="line" className="h-full gap-3 p-0" aria-label="Cloudflare views">
        <TabsTrigger value="workspace" className="h-full flex-none rounded-none px-0 text-xs">Workspace</TabsTrigger>
        <TabsTrigger value="account" className="h-full flex-none rounded-none px-0 text-xs">Account</TabsTrigger>
      </TabsList></div>

      <div className="flex min-h-0 flex-1 flex-col">
      <TabsContent value="workspace" className="flex min-h-0 flex-1 flex-col">
        {workspace && (workspace.email || workspace.account) && (
          <p className="shrink-0 truncate border-b px-4 py-1.5 text-[11px] text-muted-foreground" aria-label="Signed-in account">
            {[workspace.email, workspace.account?.name].filter(Boolean).join(" · ")}
          </p>
        )}

        {configs.length > 1 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5" role="group" aria-label="Worker">
            {configs.map((path) => (
              <FilterChip key={path} pressed={selectedConfig === path} onClick={() => { setConfig(path); setEnvironment(null) }} title={path}>
                {configLabel(path)}
              </FilterChip>
            ))}
          </div>
        )}

        {environments.length > 1 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5" role="group" aria-label="Environment">
            {environments.map((entry) => (
              <FilterChip key={entry.name ?? ""} pressed={selected?.name === entry.name} onClick={() => setEnvironment(entry.name)}>
                {environmentLabel(entry.name)}
              </FilterChip>
            ))}
          </div>
        )}

        {error && (
          <Alert variant={error.code === "cloudflare_config_missing" || error.code === "cloudflare_worker_missing" ? "default" : "destructive"} className="m-3 w-auto">
            <AlertTitle>{error.error}</AlertTitle>
            <AlertDescription>{errorHelp(error)}</AlertDescription>
          </Alert>
        )}

        {loading && !deployments && !error && <LoadingRows label="Loading Cloudflare deployments" />}

        {deployments && (
          <ScrollArea className="min-h-0 flex-1">
            {rows[0] && <LiveDeployment deployment={rows[0]} now={now} />}
            {workspace && selected && <Configuration workspace={workspace} environment={selected} />}
            {rows.length === 0 ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Cloud /></EmptyMedia>
                  <EmptyTitle>No deployments yet</EmptyTitle>
                  <EmptyDescription>Deployments of {deployments.workerName} will show up here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3 px-3 py-3" aria-label="Deployments">
                {rows.map((deployment) => (
                  <DeploymentRow key={`${projectPath}:${config}:${deployment.id}`} deployment={deployment} rowKey={`${projectPath}:${config}`} now={now} fetchVersion={fetchVersion} />
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </TabsContent>

      <TabsContent value="account" className="flex min-h-0 flex-1 flex-col">
        <AccountWorkers store={account} state={accountState} />
      </TabsContent>
      </div>
    </Tabs></NavigationContext.Provider>
  )
}
