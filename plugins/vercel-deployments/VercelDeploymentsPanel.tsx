import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Ban,
  Check,
  Clock3,
  RefreshCw,
  Rocket,
  SquareTerminal,
  X,
} from "lucide-react"
import type {
  VercelBuildLogsResponse,
  VercelDeployment,
  VercelDeploymentsErrorResponse,
  VercelDeploymentsResponse,
  VercelDeploymentState,
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
  FilterChipCount,
  ScrollArea,
  Skeleton,
  Spinner,
} from "@cogpit/plugin-ui"
import { useVercelDeployments } from "./vercelDeploymentsStore.js"

export interface VercelPanelProps {
  context: { projectPath: string | null }
  active: boolean
  closePanel?: () => void
  openExternal: (url: string) => Promise<unknown>
}
type FetchBuildLogs = (deploymentId: string, signal?: AbortSignal) => Promise<VercelBuildLogsResponse>
const NavigationContext = createContext<VercelPanelProps["openExternal"]>(() => Promise.reject(new Error("Navigation is unavailable")))

type Filter = "all" | "failed" | "preview" | "production"
type Tone = "live" | "fail" | "pass"

const RAIL_CLASS: Record<Tone, string> = {
  live: "bg-info motion-safe:animate-pulse",
  fail: "bg-destructive",
  pass: "bg-success",
}

function isActive(state: VercelDeploymentState): boolean {
  return state === "BUILDING" || state === "INITIALIZING" || state === "QUEUED"
}

function isFailed(state: VercelDeploymentState): boolean {
  return state === "BLOCKED" || state === "CANCELED" || state === "ERROR"
}

function isProduction(deployment: VercelDeployment): boolean {
  return deployment.target === "production"
}

function toneOf(state: VercelDeploymentState): Tone {
  if (isActive(state)) return "live"
  if (isFailed(state)) return "fail"
  return "pass"
}

function statusLabel(state: VercelDeploymentState): string {
  if (state === "READY") return "Ready"
  if (state === "BUILDING") return "Building"
  if (state === "INITIALIZING") return "Initializing"
  if (state === "QUEUED") return "Queued"
  if (state === "CANCELED") return "Canceled"
  if (state === "BLOCKED") return "Blocked"
  return "Failed"
}

/** Sidebar-style age: "now", "4m", "5h", "2d", then a date. */
function age(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString()
}

function duration(deployment: VercelDeployment, now: number): string | null {
  const start = deployment.buildingAt ?? deployment.createdAt
  const end = deployment.readyAt ?? (isActive(deployment.state) ? now : null)
  if (end === null) return null
  const total = Math.max(0, Math.round((end - start) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!ticking) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [ticking])
  return now
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** The commit subject when Vercel knows it; otherwise the deployment's own host, which is all a CLI deploy has. */
function deploymentTitle(deployment: VercelDeployment): string {
  return deployment.commitMessage.split("\n")[0]
    || hostOf(deployment.url)
    || `${statusLabel(deployment.state)} deployment`
}

function errorText(deployment: VercelDeployment): string | null {
  return [deployment.errorCode, deployment.errorMessage].filter(Boolean).join(": ") || null
}

function StatusGlyph({ state, className }: { state: VercelDeploymentState; className?: string }) {
  const label = statusLabel(state)
  const size = cn("size-3.5 shrink-0", className)
  if (state === "BUILDING") return <Spinner className={cn(size, "text-info")} aria-label={label} />
  if (state === "INITIALIZING" || state === "QUEUED") {
    return <Clock3 className={cn(size, "text-info")} aria-label={label} />
  }
  if (state === "READY") return <Check className={cn(size, "text-success")} aria-label={label} />
  if (state === "BLOCKED") return <Ban className={cn(size, "text-destructive")} aria-label={label} />
  return <X className={cn(size, "text-destructive")} aria-label={label} />
}

function ProductionMark() {
  return (
    <span className="shrink-0 rounded-sm border border-foreground/25 px-1 font-mono text-[9px] uppercase leading-[14px] tracking-wide text-foreground/80">
      prod
    </span>
  )
}

function errorHelp(error: VercelDeploymentsErrorResponse): string {
  if (error.code === "vercel_missing") return "Install Vercel CLI on the Cogpit host, then refresh."
  if (error.code === "vercel_cli_too_old") return "Update Vercel CLI to 50.5.1 or newer, then refresh."
  if (error.code === "vercel_auth_required") return "Run `vercel login` on the Cogpit host, then refresh."
  if (error.code === "vercel_project_unlinked") return "Run `vercel link` in this folder or its repository root. This panel checks again automatically."
  if (error.code === "vercel_access_denied") return "Sign in to an account with access to the linked Vercel project."
  return "Check the linked project and your Vercel access, then try again."
}

function LoadingDeployments() {
  return (
    <div className="flex flex-col gap-4 px-3 py-4" aria-label="Loading Vercel deployments">
      <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
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

interface LogsState {
  data: VercelBuildLogsResponse | null
  error: VercelDeploymentsErrorResponse | null
  loading: boolean
}

const EMPTY_LOGS: LogsState = { data: null, error: null, loading: false }

function BuildLogs({ logs }: { logs: VercelBuildLogsResponse }) {
  if (logs.events.length === 0) {
    return <p className="py-1 text-[11px] text-muted-foreground">Vercel reported no build output.</p>
  }
  return (
    <div className="max-h-64 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[10px] leading-4">
      {logs.events.map((event) => (
        <div key={event.id} className={cn("flex gap-2", event.type === "stderr" && "text-destructive")}>
          <time className="shrink-0 text-muted-foreground tabular-nums" dateTime={new Date(event.createdAt).toISOString()}>
            {new Date(event.createdAt).toLocaleTimeString([], { hour12: false })}
          </time>
          <span className="min-w-0 whitespace-pre-wrap break-words">{event.text}</span>
        </div>
      ))}
    </div>
  )
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

function DeploymentRow({
  deployment,
  projectPath,
  now,
  fetchBuildLogs,
}: {
  deployment: VercelDeployment
  projectPath: string
  now: number
  fetchBuildLogs: FetchBuildLogs
}) {
  const [open, setOpen] = useState(false)
  const [logsState, setLogsState] = useState<LogsState>(EMPTY_LOGS)
  const logRequest = useRef<AbortController | null>(null)
  const openExternal = useContext(NavigationContext)
  useEffect(() => () => { logRequest.current?.abort() }, [projectPath, fetchBuildLogs])
  const tone = toneOf(deployment.state)
  const elapsed = duration(deployment, now)
  const title = deploymentTitle(deployment)
  const failure = errorText(deployment)
  const host = hostOf(deployment.url)

  async function loadLogs(): Promise<void> {
    if (logsState.loading) return
    const abort = new AbortController()
    logRequest.current = abort
    setLogsState((current) => ({ ...current, error: null, loading: true }))
    try {
      const data = await fetchBuildLogs(deployment.id, abort.signal)
      if (abort.signal.aborted) return
      setLogsState({ data, error: null, loading: false })
    } catch (error) {
      if (abort.signal.aborted) return
      const detail = error && typeof error === "object" ? error as Partial<VercelDeploymentsErrorResponse> : {}
      setLogsState({
        data: null,
        error: {
          error: typeof detail.error === "string" ? detail.error : "Unable to load build output",
          code: detail.code ?? "vercel_api_failed",
        },
        loading: false,
      })
    }
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) { logRequest.current?.abort(); setLogsState(current => ({ ...current, loading: false })) }
    if (next && (!logsState.data || isActive(deployment.state))) void loadLogs()
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <article className="group/deployment relative pl-3" aria-label={title}>
        <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", RAIL_CLASS[tone])} />
        <div className="flex items-start gap-1">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
            aria-label={`${title}: ${statusLabel(deployment.state)}`}
            aria-expanded={open}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <StatusGlyph state={deployment.state} />
              <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", tone === "fail" && "text-destructive")}>
                {title}
              </span>
              {isProduction(deployment) && <ProductionMark />}
              <span className="w-7 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                {age(deployment.createdAt, now)}
              </span>
            </span>
            <span className="flex w-full min-w-0 items-center gap-2 pl-[22px] font-mono text-[10px] leading-4 text-muted-foreground">
              {deployment.branch && <span className="min-w-0 truncate">{deployment.branch}</span>}
              {deployment.commitSha && <span className="shrink-0">{deployment.commitSha.slice(0, 7)}</span>}
              {!deployment.branch && !deployment.commitSha && <span className="min-w-0 truncate">deployed from CLI</span>}
              <span className="min-w-0 flex-1" />
              {elapsed && (
                <span className={cn("shrink-0 tabular-nums", tone === "live" && "text-info")}>{elapsed}</span>
              )}
            </span>
            {failure && (
              <span className="w-full min-w-0 truncate pl-[22px] text-[11px] leading-4 text-destructive" title={failure}>
                {failure}
              </span>
            )}
          </CollapsibleTrigger>
          {deployment.url && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-6 text-muted-foreground opacity-0 transition-opacity group-hover/deployment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Open ${title}`}
              onClick={() => { void openExternal(deployment.url!).catch(() => {}) }}
            >
              <ArrowUpRight />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          <div className="ml-[7px] flex flex-col gap-2 border-l border-border py-2 pl-4 pr-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              {deployment.url && host && <ExternalLink href={deployment.url}>{host}</ExternalLink>}
              {deployment.inspectorUrl && <ExternalLink href={deployment.inspectorUrl}>Inspect on Vercel</ExternalLink>}
              {deployment.creator && (
                <span className="text-[11px] text-muted-foreground">by {deployment.creator}</span>
              )}
            </div>
            {logsState.loading && !logsState.data && (
              <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground" role="status">
                <Spinner className="size-3" />
                Loading build output
              </div>
            )}
            {logsState.error && <p className="text-[11px] text-destructive">{logsState.error.error}</p>}
            {logsState.data && <BuildLogs logs={logsState.data} />}
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}

/** What visitors get right now, plus a newer production deployment if one is still on its way or fell over. */
export function productionSummary(deployments: readonly VercelDeployment[]): {
  live: VercelDeployment | null
  pending: VercelDeployment | null
} {
  const production = deployments.filter(isProduction)
  const live = production.find((deployment) => deployment.state === "READY") ?? null
  const newest = production[0] ?? null
  const pending = newest && newest !== live && newest.state !== "READY" ? newest : null
  return { live, pending }
}

function LiveProduction({ deployments, now }: { deployments: readonly VercelDeployment[]; now: number }) {
  const { live, pending } = productionSummary(deployments)
  const shown = live ?? pending
  if (!shown) return null
  const title = deploymentTitle(shown)
  const host = hostOf(shown.url)
  const pendingTone = pending ? toneOf(pending.state) : null

  return (
    <section
      aria-label="Production"
      className={cn(
        "mx-3 mt-3 rounded-md border px-3 py-2.5",
        live ? "border-success/30 bg-success/[0.05]" : "border-destructive/30 bg-destructive/[0.05]",
      )}
    >
      <p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", live ? "bg-success" : "bg-destructive")}
        />
        {live ? "Live on production" : "Production is down"}
        <span className="ml-auto font-mono normal-case tracking-normal tabular-nums">
          {age(shown.readyAt ?? shown.createdAt, now)}
        </span>
      </p>
      <h3 className="truncate text-[13px] font-medium leading-5" title={title}>{title}</h3>
      <p className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
        {shown.branch && <span className="truncate">{shown.branch}</span>}
        {shown.commitSha && <span className="shrink-0">{shown.commitSha.slice(0, 7)}</span>}
        <span className="min-w-0 flex-1" />
        {shown.url && host && (
          <ExternalLink
            href={shown.url}
            className="inline-flex min-w-0 max-w-[60%] items-center gap-0.5 font-sans text-[11px] text-foreground/80 outline-none hover:text-foreground focus-visible:underline"
          >
            {host}
          </ExternalLink>
        )}
      </p>
      {live && pending && pendingTone && (
        <p
          className={cn(
            "mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-[11px]",
            pendingTone === "fail" ? "text-destructive" : "text-info",
          )}
        >
          <StatusGlyph state={pending.state} className="size-3" />
          <span className="min-w-0 truncate">
            {pendingTone === "fail" ? "Newer production deploy failed" : "Newer production deploy in progress"}
            {" · "}
            {deploymentTitle(pending)}
          </span>
        </p>
      )}
    </section>
  )
}

function applyFilter(deployments: readonly VercelDeployment[], filter: Filter): VercelDeployment[] {
  if (filter === "failed") return deployments.filter((deployment) => isFailed(deployment.state))
  if (filter === "production") return deployments.filter(isProduction)
  if (filter === "preview") return deployments.filter((deployment) => !isProduction(deployment))
  return [...deployments]
}

function DeploymentLedger({
  data,
  filter,
  projectPath,
  fetchBuildLogs,
}: {
  data: VercelDeploymentsResponse
  filter: Filter
  projectPath: string
  fetchBuildLogs: FetchBuildLogs
}) {
  const deployments = useMemo(() => applyFilter(data.deployments, filter), [data.deployments, filter])
  const now = useNow(data.deployments.some((deployment) => isActive(deployment.state)))

  if (data.deployments.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Rocket /></EmptyMedia>
          <EmptyTitle>No deployments yet</EmptyTitle>
          <EmptyDescription>New Vercel deployments for this linked project will show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <LiveProduction deployments={data.deployments} now={now} />
      {deployments.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">No recent {filter} deployments.</p>
      ) : (
        <div className="flex flex-col gap-3 px-3 py-3">
          {deployments.map((deployment) => (
            <DeploymentRow key={`${projectPath}:${deployment.id}`} deployment={deployment} projectPath={projectPath} now={now} fetchBuildLogs={fetchBuildLogs} />
          ))}
        </div>
      )}
    </ScrollArea>
  )
}

export function VercelDeploymentsPanel({ context, active, closePanel, openExternal }: VercelPanelProps) {
  const { data, error, loading, refreshing, refresh, fetchBuildLogs } = useVercelDeployments(context.projectPath, active)
  const [filter, setFilter] = useState<Filter>("all")
  const projectPath = context.projectPath
  const deployments = data?.deployments ?? []
  const counts: Record<Filter, number> = {
    all: deployments.length,
    production: deployments.filter(isProduction).length,
    preview: deployments.filter((deployment) => !isProduction(deployment)).length,
    failed: deployments.filter((deployment) => isFailed(deployment.state)).length,
  }
  const effectiveFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter

  return (
    <NavigationContext.Provider value={openExternal}><section className="flex size-full min-h-0 flex-col" aria-label="Vercel deployments panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">Vercel Deployments</h2>
          {data?.projectUrl ? (
            <ExternalLink
              href={data.projectUrl}
              className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              {data.projectName}
            </ExternalLink>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">Deployments for this workspace</p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => { void refresh() }}
          disabled={loading || refreshing || !projectPath}
          aria-label="Refresh Vercel deployments"
        >
          {refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
        {closePanel && <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close Vercel deployments">
          <X />
        </Button>}
      </header>

      {data && data.deployments.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5" role="group" aria-label="Filter deployments">
          <FilterChip pressed={effectiveFilter === "all"} onClick={() => setFilter("all")}>
            All <FilterChipCount>{counts.all}</FilterChipCount>
          </FilterChip>
          <FilterChip
            pressed={effectiveFilter === "production"}
            disabled={counts.production === 0}
            onClick={() => setFilter("production")}
          >
            Production <FilterChipCount>{counts.production}</FilterChipCount>
          </FilterChip>
          <FilterChip
            pressed={effectiveFilter === "preview"}
            disabled={counts.preview === 0}
            onClick={() => setFilter("preview")}
          >
            Preview <FilterChipCount>{counts.preview}</FilterChipCount>
          </FilterChip>
          <FilterChip
            pressed={effectiveFilter === "failed"}
            disabled={counts.failed === 0}
            onClick={() => setFilter("failed")}
          >
            <span className={cn(counts.failed > 0 && "text-destructive")}>Failed</span>
            {" "}
            <FilterChipCount>{counts.failed}</FilterChipCount>
          </FilterChip>
        </div>
      )}

      {loading && !data && <LoadingDeployments />}
      {error && !data && (
        <div className="p-3">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{error.error}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{errorHelp(error)}</span>
              <Button type="button" variant="outline" size="xs" onClick={() => { void refresh() }}>
                <RefreshCw data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
      {data && projectPath && <DeploymentLedger data={data} filter={effectiveFilter} projectPath={projectPath} fetchBuildLogs={fetchBuildLogs} />}
      {!loading && !data && !error && (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><SquareTerminal /></EmptyMedia>
            <EmptyTitle>Select a project session</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </section></NavigationContext.Provider>
  )
}
