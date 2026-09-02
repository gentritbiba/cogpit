import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Ban,
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
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
} from "../../shared/contracts/vercelDeployments"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
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
  ScrollArea,
  Skeleton,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
  type WorkspacePanelIndicatorProps,
  type WorkspacePanelProps,
} from "@/plugin-api"
import { fetchVercelBuildLogs, useVercelDeployments } from "./vercelDeploymentsStore"

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

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

function environmentLabel(deployment: VercelDeployment): string {
  return deployment.target || "preview"
}

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000)
  if (Math.abs(seconds) < 60) return RELATIVE_TIME.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(hours, "hour")
  return RELATIVE_TIME.format(Math.round(hours / 24), "day")
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

function StatusGlyph({ state }: { state: VercelDeploymentState }) {
  const label = statusLabel(state)
  if (state === "BUILDING") return <Spinner className="size-3.5 text-info" aria-label={label} />
  if (state === "INITIALIZING" || state === "QUEUED") {
    return <Clock3 className="size-3.5 text-info" aria-label={label} />
  }
  if (state === "READY") return <Check className="size-3.5 text-success" aria-label={label} />
  if (state === "BLOCKED") return <Ban className="size-3.5 text-destructive" aria-label={label} />
  return <X className="size-3.5 text-destructive" aria-label={label} />
}

function errorHelp(error: VercelDeploymentsErrorResponse): string {
  if (error.code === "vercel_missing") return "Install Vercel CLI on the Cogpit host, then refresh."
  if (error.code === "vercel_cli_too_old") return "Update Vercel CLI to 50.5.1 or newer, then refresh."
  if (error.code === "vercel_auth_required") return "Run `vercel login` on the Cogpit host, then refresh."
  if (error.code === "vercel_project_unlinked") return "Run `vercel link` from this exact project root."
  if (error.code === "vercel_access_denied") return "Sign in to an account with access to the linked Vercel project."
  return "Check the linked project and your Vercel access, then try again."
}

function LoadingDeployments() {
  return (
    <div className="flex flex-col gap-4 px-3 py-4" aria-label="Loading Vercel deployments">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex items-start gap-3 border-l-2 border-border pl-3">
          <Skeleton className="mt-1 size-3.5 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
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
    return <p className="py-2 text-[11px] text-muted-foreground">Vercel reported no build output.</p>
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

function deploymentTitle(deployment: VercelDeployment): string {
  return deployment.commitMessage.split("\n")[0] || `${statusLabel(deployment.state)} deployment`
}

function DeploymentRow({
  deployment,
  projectPath,
  now,
}: {
  deployment: VercelDeployment
  projectPath: string
  now: number
}) {
  const [open, setOpen] = useState(false)
  const [logsState, setLogsState] = useState<LogsState>(EMPTY_LOGS)
  const tone = toneOf(deployment.state)
  const elapsed = duration(deployment, now)
  const title = deploymentTitle(deployment)

  async function loadLogs(): Promise<void> {
    if (logsState.loading) return
    setLogsState((current) => ({ ...current, error: null, loading: true }))
    try {
      const data = await fetchVercelBuildLogs(projectPath, deployment.id)
      setLogsState({ data, error: null, loading: false })
    } catch (error) {
      const detail = error as Partial<VercelDeploymentsErrorResponse>
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
    if (next && (!logsState.data || isActive(deployment.state))) void loadLogs()
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <article className="group/deployment relative pl-3" aria-label={title}>
        <span
          aria-hidden
          className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", RAIL_CLASS[tone])}
        />
        <div className="flex items-start gap-1">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-start gap-2 rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
            aria-label={`${title}: ${statusLabel(deployment.state)}`}
          >
            <ChevronRight
              className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
            <StatusGlyph state={deployment.state} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={cn("truncate text-xs font-medium", tone === "fail" && "text-destructive")} title={title}>
                {title}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                {deployment.branch && (
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="max-w-28 truncate">{deployment.branch}</span>
                  </span>
                )}
                {deployment.commitSha && <span className="font-mono">{deployment.commitSha.slice(0, 7)}</span>}
                {deployment.creator && <span className="max-w-20 truncate">{deployment.creator}</span>}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <Badge
                variant={tone === "fail" ? "destructive" : "outline"}
                className="h-4 px-1.5 text-[9px] capitalize"
              >
                {environmentLabel(deployment)}
              </Badge>
              <span className="font-mono text-[9px] text-muted-foreground tabular-nums">
                {elapsed ? `${elapsed} · ` : ""}{relativeTime(deployment.createdAt, now)}
              </span>
            </span>
          </CollapsibleTrigger>
          {deployment.url && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/deployment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Open ${title}`}
              onClick={() => window.open(deployment.url ?? "", "_blank", "noopener,noreferrer")}
            >
              <ArrowUpRight />
            </Button>
          )}
        </div>
        <CollapsibleContent>
          <div className="ml-[7px] flex flex-col gap-2 border-l border-border py-2 pl-4 pr-1">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{deployment.id}</span>
              {deployment.inspectorUrl && (
                <a
                  href={deployment.inspectorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 outline-none hover:text-foreground focus-visible:underline"
                >
                  Inspect on Vercel
                  <ArrowUpRight className="size-3" />
                </a>
              )}
            </div>
            {(deployment.errorCode || deployment.errorMessage) && (
              <p className="text-[11px] text-destructive">
                {[deployment.errorCode, deployment.errorMessage].filter(Boolean).join(": ")}
              </p>
            )}
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

function applyFilter(deployments: readonly VercelDeployment[], filter: Filter): VercelDeployment[] {
  if (filter === "failed") return deployments.filter((deployment) => isFailed(deployment.state))
  if (filter === "production") return deployments.filter((deployment) => deployment.target === "production")
  if (filter === "preview") return deployments.filter((deployment) => deployment.target !== "production")
  return [...deployments]
}

function DeploymentLedger({
  data,
  filter,
  projectPath,
}: {
  data: VercelDeploymentsResponse
  filter: Filter
  projectPath: string
}) {
  const deployments = useMemo(() => applyFilter(data.deployments, filter), [data.deployments, filter])
  const now = useNow(deployments.some((deployment) => isActive(deployment.state)))

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
  if (deployments.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">No recent {filter} deployments.</p>
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 px-3 py-3">
        {deployments.map((deployment) => (
          <DeploymentRow key={deployment.id} deployment={deployment} projectPath={projectPath} now={now} />
        ))}
      </div>
    </ScrollArea>
  )
}

export function VercelDeploymentsIndicator({ context }: WorkspacePanelIndicatorProps) {
  const { data } = useVercelDeployments(context.projectPath, context.projectPath !== null)
  const activeCount = data?.deployments.filter((deployment) => isActive(deployment.state)).length ?? 0
  const latestFailed = data?.deployments[0] ? isFailed(data.deployments[0].state) : false

  if (activeCount > 0) {
    return (
      <Badge
        className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]"
        aria-label={`${activeCount} active Vercel deployment${activeCount === 1 ? "" : "s"}`}
      >
        {activeCount}
      </Badge>
    )
  }
  if (latestFailed) {
    return (
      <Badge
        variant="destructive"
        className="absolute -right-0.5 -top-0.5 size-3 p-0 text-[8px]"
        aria-label="Latest Vercel deployment failed"
      >
        !
      </Badge>
    )
  }
  return null
}

export function VercelDeploymentsPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const { data, error, loading, refreshing, refresh } = useVercelDeployments(context.projectPath, active)
  const [filter, setFilter] = useState<Filter>("all")
  const projectPath = context.projectPath
  const deployments = data?.deployments ?? []
  const counts: Record<Filter, number> = {
    all: deployments.length,
    production: deployments.filter((deployment) => deployment.target === "production").length,
    preview: deployments.filter((deployment) => deployment.target !== "production").length,
    failed: deployments.filter((deployment) => isFailed(deployment.state)).length,
  }
  const effectiveFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter

  return (
    <section className="flex size-full min-h-0 flex-col" aria-label="Vercel deployments panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">Vercel Deployments</h2>
          {data?.projectUrl ? (
            <a
              href={data.projectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              <span className="truncate">{data.projectName}</span>
              <ArrowUpRight className="size-3 shrink-0" />
            </a>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">Project linked at the session root</p>
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
        <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close Vercel deployments">
          <X />
        </Button>
      </header>

      {data && data.deployments.length > 0 && (
        <div className="shrink-0 overflow-x-auto border-b px-3 py-1.5">
          <ToggleGroup
            value={[effectiveFilter]}
            onValueChange={(value) => { if (value[0]) setFilter(value[0] as Filter) }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Filter deployments"
          >
            <ToggleGroupItem value="all" className="h-6 gap-1 px-2 text-[10px]">
              All <span className="font-mono opacity-70">{counts.all}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="production" disabled={counts.production === 0} className="h-6 gap-1 px-2 text-[10px]">
              Production <span className="font-mono opacity-70">{counts.production}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" disabled={counts.preview === 0} className="h-6 gap-1 px-2 text-[10px]">
              Preview <span className="font-mono opacity-70">{counts.preview}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="failed" disabled={counts.failed === 0} className="h-6 gap-1 px-2 text-[10px]">
              Failed <span className="font-mono opacity-70">{counts.failed}</span>
            </ToggleGroupItem>
          </ToggleGroup>
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
      {data && projectPath && <DeploymentLedger data={data} filter={effectiveFilter} projectPath={projectPath} />}
      {!loading && !data && !error && (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><SquareTerminal /></EmptyMedia>
            <EmptyTitle>Select a project session</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  )
}
