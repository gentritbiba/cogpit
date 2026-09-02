import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  CircleMinus,
  Clock3,
  GitBranch,
  RefreshCw,
  Workflow,
  X,
} from "lucide-react"
import type {
  GitHubActionsErrorResponse,
  GitHubActionsJob,
  GitHubActionsJobsResponse,
  GitHubActionsRun,
  GitHubActionsRunsResponse,
  GitHubActionsStep,
  GitHubWorkflowConclusion,
  GitHubWorkflowStatus,
} from "../../shared/contracts/githubActions"
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
  type WorkspacePanelIndicatorProps,
  type WorkspacePanelProps,
} from "@/plugin-api"
import { fetchGitHubActionsJobs, useGitHubActions } from "./githubActionsStore"

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** Visual weight of a run, from the one that needs attention to the one that needs none. */
type Tone = "live" | "fail" | "pass" | "quiet"
type Filter = "all" | "branch" | "failed"

function isActive(status: GitHubWorkflowStatus): boolean {
  return status !== "completed"
}

function isFailed(conclusion: GitHubWorkflowConclusion): boolean {
  return conclusion === "action_required"
    || conclusion === "failure"
    || conclusion === "startup_failure"
    || conclusion === "timed_out"
}

function toneOf(status: GitHubWorkflowStatus, conclusion: GitHubWorkflowConclusion): Tone {
  if (isActive(status)) return "live"
  if (isFailed(conclusion)) return "fail"
  if (conclusion === "success") return "pass"
  return "quiet"
}

const TONE_ORDER: Record<Tone, number> = { live: 0, fail: 1, quiet: 2, pass: 3 }

function worstTone(tones: Tone[]): Tone {
  return tones.reduce<Tone>((worst, tone) => TONE_ORDER[tone] < TONE_ORDER[worst] ? tone : worst, "pass")
}

const RAIL_CLASS: Record<Tone, string> = {
  live: "bg-info motion-safe:animate-pulse",
  fail: "bg-destructive",
  pass: "bg-success",
  quiet: "bg-border",
}

function statusLabel(status: GitHubWorkflowStatus, conclusion: GitHubWorkflowConclusion): string {
  if (status === "in_progress") return "Running"
  if (isActive(status)) return "Queued"
  if (conclusion === "success") return "Passed"
  if (conclusion === "cancelled") return "Cancelled"
  if (conclusion === "skipped") return "Skipped"
  if (conclusion === "timed_out") return "Timed out"
  if (conclusion === "action_required") return "Needs action"
  if (conclusion === "neutral" || conclusion === "stale") return "Neutral"
  return "Failed"
}

function relativeTime(timestamp: string, now: number): string {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) return "Unknown time"
  const seconds = Math.round((value - now) / 1000)
  if (Math.abs(seconds) < 60) return RELATIVE_TIME.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(hours, "hour")
  return RELATIVE_TIME.format(Math.round(hours / 24), "day")
}

function duration(start: string | null, end: string | null, now: number): string | null {
  const from = start ? Date.parse(start) : Number.NaN
  if (!Number.isFinite(from)) return null
  const to = end ? Date.parse(end) : now
  const total = Math.max(0, Math.round((to - from) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A wall clock that only ticks while something is still running. */
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

function StatusGlyph({
  status,
  conclusion,
  className,
}: {
  status: GitHubWorkflowStatus
  conclusion: GitHubWorkflowConclusion
  className?: string
}) {
  const label = statusLabel(status, conclusion)
  const size = cn("size-3.5 shrink-0", className)
  if (status === "in_progress") return <Spinner className={cn(size, "text-info")} aria-label={label} />
  if (isActive(status)) return <Clock3 className={cn(size, "text-info")} aria-label={label} />
  if (conclusion === "success") return <Check className={cn(size, "text-success")} aria-label={label} />
  if (isFailed(conclusion)) return <X className={cn(size, "text-destructive")} aria-label={label} />
  if (conclusion === "skipped" || conclusion === "cancelled") {
    return <CircleMinus className={cn(size, "text-muted-foreground")} aria-label={label} />
  }
  return <Circle className={cn(size, "text-muted-foreground")} aria-label={label} />
}

function errorHelp(error: GitHubActionsErrorResponse): string {
  if (error.code === "gh_missing") return "Install GitHub CLI, then refresh this panel."
  if (error.code === "gh_auth_required") return "Run `gh auth login` on the Cogpit host, then refresh."
  if (error.code === "no_github_remote") return "Add a GitHub origin remote to this repository."
  return "Check the repository and your GitHub access, then try again."
}

function LoadingRuns() {
  return (
    <div className="flex flex-col gap-5 px-3 py-4" aria-label="Loading workflow runs">
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex flex-col gap-2 border-l-2 border-border pl-3">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

function StepRow({ step, now }: { step: GitHubActionsStep; now: number }) {
  const failed = isFailed(step.conclusion)
  const skipped = step.conclusion === "skipped"
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5 text-[11px] leading-5">
      <StatusGlyph status={step.status} conclusion={step.conclusion} className="size-3" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          failed && "font-medium text-destructive",
          skipped && "text-muted-foreground",
        )}
      >
        {step.name}
      </span>
      {!skipped && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          {duration(step.startedAt, step.completedAt, now)}
        </span>
      )}
    </li>
  )
}

function JobBlock({ job, now }: { job: GitHubActionsJob; now: number }) {
  const tone = toneOf(job.status, job.conclusion)
  // Steps only carry information when something broke or is still moving.
  const [open, setOpen] = useState(tone === "fail" || tone === "live")
  const elapsed = duration(job.startedAt, job.completedAt, now)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
        aria-label={`${job.name}: ${statusLabel(job.status, job.conclusion)}`}
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <StatusGlyph status={job.status} conclusion={job.conclusion} />
        <span className={cn("min-w-0 flex-1 truncate", tone === "fail" && "text-destructive")}>{job.name}</span>
        {elapsed && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{elapsed}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {job.steps.length > 0 && (
          <ul className="ml-[5px] border-l border-border pl-4">
            {job.steps.map((step) => <StepRow key={step.number} step={step} now={now} />)}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface JobsState {
  data: GitHubActionsJobsResponse | null
  error: GitHubActionsErrorResponse | null
  loading: boolean
}

const EMPTY_JOBS: JobsState = { data: null, error: null, loading: false }

function RunRow({ run, projectPath, now }: { run: GitHubActionsRun; projectPath: string; now: number }) {
  const [open, setOpen] = useState(false)
  const [jobsState, setJobsState] = useState<JobsState>(EMPTY_JOBS)
  const tone = toneOf(run.status, run.conclusion)
  const active = tone === "live"

  async function loadJobs(): Promise<void> {
    if (jobsState.loading) return
    setJobsState((current) => ({ ...current, error: null, loading: true }))
    try {
      const data = await fetchGitHubActionsJobs(projectPath, run.id)
      setJobsState({ data, error: null, loading: false })
    } catch (error) {
      const detail = error as GitHubActionsErrorResponse
      setJobsState({
        data: null,
        error: {
          error: typeof detail.error === "string" ? detail.error : "Unable to load workflow jobs",
          code: detail.code ?? "github_api_failed",
        },
        loading: false,
      })
    }
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (next && (!jobsState.data || active)) void loadJobs()
  }

  const jobs = jobsState.data?.jobs ?? []
  const elapsed = duration(run.createdAt, active ? null : run.updatedAt, now)

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <div className="group/run flex items-center gap-1 pr-1">
        <CollapsibleTrigger
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
          aria-label={`${run.name} #${run.runNumber}: ${statusLabel(run.status, run.conclusion)}`}
          aria-expanded={open}
        >
          <StatusGlyph status={run.status} conclusion={run.conclusion} />
          <span className={cn("min-w-0 truncate", tone === "quiet" && "text-muted-foreground")}>
            {run.name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">#{run.runNumber}</span>
          <span className="min-w-0 flex-1" />
          <span className="max-w-24 truncate font-mono text-[10px] text-muted-foreground">{run.branch}</span>
          {elapsed && (
            <span
              className={cn(
                "w-14 shrink-0 text-right font-mono text-[10px] tabular-nums",
                active ? "text-info" : "text-muted-foreground",
              )}
            >
              {elapsed}
            </span>
          )}
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/run:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Open ${run.name} #${run.runNumber} on GitHub`}
          onClick={() => window.open(run.url, "_blank", "noopener,noreferrer")}
        >
          <ArrowUpRight />
        </Button>
      </div>
      <CollapsibleContent>
        <div className="ml-[7px] border-l border-border py-1 pl-3 pr-1">
          {jobsState.loading && !jobsState.data && (
            <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground" role="status">
              <Spinner className="size-3" />
              Loading jobs
            </div>
          )}
          {jobsState.error && (
            <p className="py-1 text-[11px] text-destructive">{jobsState.error.error}</p>
          )}
          {!jobsState.loading && !jobsState.error && jobsState.data && jobs.length === 0 && (
            <p className="py-1 text-[11px] text-muted-foreground">GitHub reported no jobs for this run.</p>
          )}
          {jobs.map((job) => <JobBlock key={job.id} job={job} now={now} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface CommitGroup {
  sha: string
  title: string
  actor: string
  createdAt: string
  runs: GitHubActionsRun[]
  tone: Tone
}

/** GitHub lists one run per workflow; the person reading pushed one commit. Fold runs back onto it. */
export function groupRunsByCommit(runs: readonly GitHubActionsRun[]): CommitGroup[] {
  const groups = new Map<string, CommitGroup>()
  for (const run of runs) {
    const key = run.commitSha || `run-${run.id}`
    const group = groups.get(key)
    if (group) {
      group.runs.push(run)
      if (run.createdAt > group.createdAt) group.createdAt = run.createdAt
      continue
    }
    groups.set(key, {
      sha: run.commitSha,
      title: run.displayTitle,
      actor: run.actor,
      createdAt: run.createdAt,
      runs: [run],
      tone: "pass",
    })
  }
  const list = [...groups.values()]
  for (const group of list) group.tone = worstTone(group.runs.map((run) => toneOf(run.status, run.conclusion)))
  return list.sort((a, b) => {
    const liveA = a.tone === "live" ? 0 : 1
    const liveB = b.tone === "live" ? 0 : 1
    return liveA - liveB || b.createdAt.localeCompare(a.createdAt)
  })
}

function CommitBlock({ group, projectPath, now }: { group: CommitGroup; projectPath: string; now: number }) {
  return (
    <article className="relative pl-3" aria-label={group.title}>
      <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", RAIL_CLASS[group.tone])} />
      <header className="mb-1 min-w-0">
        <h3 className="truncate text-[13px] font-medium leading-5" title={group.title}>{group.title}</h3>
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          {group.sha && <span className="font-mono">{group.sha.slice(0, 7)}</span>}
          {group.actor && <span className="truncate">{group.actor}</span>}
          <span className="shrink-0">·</span>
          <time
            className="shrink-0"
            dateTime={group.createdAt}
            title={new Date(group.createdAt).toLocaleString()}
          >
            {relativeTime(group.createdAt, now)}
          </time>
        </p>
      </header>
      <div className="-ml-1 flex flex-col">
        {group.runs.map((run) => <RunRow key={run.id} run={run} projectPath={projectPath} now={now} />)}
      </div>
    </article>
  )
}

export function GitHubActionsIndicator({ context }: WorkspacePanelIndicatorProps) {
  const { data } = useGitHubActions(context.projectPath, context.projectPath !== null)
  const activeCount = data?.runs.filter((run) => isActive(run.status)).length ?? 0
  const latestFailed = data?.runs[0]?.conclusion ? isFailed(data.runs[0].conclusion) : false

  if (activeCount > 0) {
    return (
      <Badge
        className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]"
        aria-label={`${activeCount} active GitHub Actions run${activeCount === 1 ? "" : "s"}`}
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
        aria-label="Latest GitHub Actions run failed"
      >
        !
      </Badge>
    )
  }
  return null
}

function FilterChip({
  pressed,
  disabled,
  onClick,
  children,
  ...rest
}: {
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
  "aria-label"?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-none outline-none transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:opacity-40",
        pressed
          ? "border-foreground/20 bg-foreground/[0.06] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

function applyFilter(runs: readonly GitHubActionsRun[], filter: Filter, branch: string | null): GitHubActionsRun[] {
  if (filter === "branch") return runs.filter((run) => run.branch === branch)
  if (filter === "failed") return runs.filter((run) => isFailed(run.conclusion))
  return [...runs]
}

function RunsLedger({
  data,
  filter,
  projectPath,
}: {
  data: GitHubActionsRunsResponse
  filter: Filter
  projectPath: string
}) {
  const runs = useMemo(() => applyFilter(data.runs, filter, data.branch), [data, filter])
  const groups = useMemo(() => groupRunsByCommit(runs), [runs])
  const now = useNow(groups.some((group) => group.tone === "live"))

  if (data.runs.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Workflow /></EmptyMedia>
          <EmptyTitle>No workflow runs yet</EmptyTitle>
          <EmptyDescription>Push a commit that triggers a workflow and it will show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        {filter === "failed" ? "Nothing failed in the latest runs." : `No recent runs on ${data.branch}.`}
      </p>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-5 px-3 py-3">
        {groups.map((group) => (
          <CommitBlock key={group.sha || group.runs[0].id} group={group} projectPath={projectPath} now={now} />
        ))}
      </div>
    </ScrollArea>
  )
}

export function GitHubActionsPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const { data, error, loading, refreshing, refresh } = useGitHubActions(context.projectPath, active)
  const [filter, setFilter] = useState<Filter>("all")
  const projectPath = context.projectPath
  const runs = data?.runs ?? []
  const failedCount = runs.filter((run) => isFailed(run.conclusion)).length
  const branch = data?.branch ?? null
  const branchCount = branch ? runs.filter((run) => run.branch === branch).length : 0
  const effectiveFilter = (filter === "branch" && !branch) || (filter === "failed" && failedCount === 0)
    ? "all"
    : filter

  return (
    <section className="flex size-full min-h-0 flex-col" aria-label="GitHub Actions panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">GitHub Actions</h2>
          {data ? (
            <a
              href={`${data.repositoryUrl}/actions`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              <span className="truncate">{data.repository}</span>
              <ArrowUpRight className="size-3 shrink-0" />
            </a>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">Current repository</p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => { void refresh() }}
          disabled={loading || refreshing || !projectPath}
          aria-label="Refresh GitHub Actions"
        >
          {refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close GitHub Actions">
          <X />
        </Button>
      </header>

      {data && data.runs.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5" role="group" aria-label="Filter runs">
          <FilterChip pressed={effectiveFilter === "all"} onClick={() => setFilter("all")}>
            All
            <span className="font-mono text-[10px] tabular-nums opacity-70">{runs.length}</span>
          </FilterChip>
          {branch && (
            <FilterChip
              pressed={effectiveFilter === "branch"}
              disabled={branchCount === 0}
              onClick={() => setFilter("branch")}
              aria-label={`Only runs on ${branch}`}
            >
              <GitBranch className="size-3" />
              <span className="max-w-28 truncate">{branch}</span>
              <span className="font-mono text-[10px] tabular-nums opacity-70">{branchCount}</span>
            </FilterChip>
          )}
          <FilterChip
            pressed={effectiveFilter === "failed"}
            disabled={failedCount === 0}
            onClick={() => setFilter("failed")}
          >
            <span className={cn(failedCount > 0 && "text-destructive")}>Failed</span>
            <span className="font-mono text-[10px] tabular-nums opacity-70">{failedCount}</span>
          </FilterChip>
        </div>
      )}

      {loading && !data && <LoadingRuns />}
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
      {data && projectPath && <RunsLedger data={data} filter={effectiveFilter} projectPath={projectPath} />}
    </section>
  )
}
