import { useState } from "react"
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleMinus,
  Clock3,
  GitBranch,
  Github,
  RefreshCw,
  Workflow,
  X,
  XCircle,
} from "lucide-react"
import type {
  GitHubActionsErrorResponse,
  GitHubActionsJob,
  GitHubActionsJobsResponse,
  GitHubActionsRun,
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Progress,
  ScrollArea,
  Separator,
  Skeleton,
  Spinner,
  type WorkspacePanelIndicatorProps,
  type WorkspacePanelProps,
} from "@/plugin-api"
import { fetchGitHubActionsJobs, useGitHubActions } from "./githubActionsStore"

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

function isActive(status: GitHubWorkflowStatus): boolean {
  return status !== "completed"
}

function isFailed(conclusion: GitHubWorkflowConclusion): boolean {
  return conclusion === "action_required"
    || conclusion === "failure"
    || conclusion === "startup_failure"
    || conclusion === "timed_out"
}

function statusLabel(status: GitHubWorkflowStatus, conclusion: GitHubWorkflowConclusion): string {
  if (status === "in_progress") return "Running"
  if (status === "queued" || status === "requested" || status === "waiting" || status === "pending") {
    return "Queued"
  }
  if (conclusion === "success") return "Passed"
  if (conclusion === "cancelled") return "Cancelled"
  if (conclusion === "skipped") return "Skipped"
  if (conclusion === "timed_out") return "Timed out"
  if (conclusion === "action_required") return "Needs action"
  if (conclusion === "neutral" || conclusion === "stale") return "Neutral"
  return "Failed"
}

function statusVariant(
  status: GitHubWorkflowStatus,
  conclusion: GitHubWorkflowConclusion,
): "default" | "secondary" | "destructive" | "outline" {
  if (isActive(status)) return "default"
  if (isFailed(conclusion)) return "destructive"
  if (conclusion === "success") return "secondary"
  return "outline"
}

function relativeTime(timestamp: string): string {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) return "Unknown time"
  const seconds = Math.round((value - Date.now()) / 1000)
  if (Math.abs(seconds) < 60) return RELATIVE_TIME.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(hours, "hour")
  return RELATIVE_TIME.format(Math.round(hours / 24), "day")
}

function StatusIcon({
  status,
  conclusion,
}: {
  status: GitHubWorkflowStatus
  conclusion: GitHubWorkflowConclusion
}) {
  if (status === "in_progress") return <Spinner className="size-4" aria-label="Running" />
  if (isActive(status)) return <Clock3 className="size-4" aria-label="Queued" />
  if (conclusion === "success") return <CheckCircle2 className="size-4" aria-label="Passed" />
  if (isFailed(conclusion)) return <XCircle className="size-4 text-destructive" aria-label="Failed" />
  if (conclusion === "skipped" || conclusion === "cancelled") {
    return <CircleMinus className="size-4 text-muted-foreground" aria-label="Skipped" />
  }
  return <Circle className="size-4 text-muted-foreground" aria-label="Completed" />
}

function errorHelp(error: GitHubActionsErrorResponse): string {
  if (error.code === "gh_missing") return "Install GitHub CLI, then refresh this panel."
  if (error.code === "gh_auth_required") return "Run `gh auth login` on the Cogpit host, then refresh."
  if (error.code === "no_github_remote") return "Add a GitHub origin remote to this repository."
  return "Check the repository and your GitHub access, then try again."
}

function LoadingRuns() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-label="Loading workflow runs">
      {[0, 1, 2].map((item) => (
        <Card key={item} size="sm">
          <CardHeader>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-7 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function StepRow({ step }: { step: GitHubActionsStep }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-1 text-xs">
      <StatusIcon status={step.status} conclusion={step.conclusion} />
      <span className={cn("min-w-0 flex-1 truncate", step.conclusion === "skipped" && "text-muted-foreground")}>
        {step.name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {statusLabel(step.status, step.conclusion)}
      </span>
    </li>
  )
}

function JobDetails({ job }: { job: GitHubActionsJob }) {
  const completedSteps = job.steps.filter((step) => step.status === "completed").length
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={job.status} conclusion={job.conclusion} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{job.name}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {completedSteps}/{job.steps.length}
        </span>
      </div>
      {isActive(job.status) && (
        <Progress
          value={job.steps.length > 0 ? Math.round(completedSteps / job.steps.length * 100) : null}
          aria-label={`${job.name} progress`}
          className="mt-2 gap-0"
        />
      )}
      {job.steps.length > 0 && (
        <ul className="mt-1.5 divide-y">{job.steps.map((step) => <StepRow key={step.number} step={step} />)}</ul>
      )}
    </div>
  )
}

interface JobsState {
  data: GitHubActionsJobsResponse | null
  error: GitHubActionsErrorResponse | null
  loading: boolean
}

const EMPTY_JOBS: JobsState = { data: null, error: null, loading: false }

function RunCard({ run, projectPath }: { run: GitHubActionsRun; projectPath: string }) {
  const [jobsOpen, setJobsOpen] = useState(false)
  const [jobsState, setJobsState] = useState<JobsState>(EMPTY_JOBS)
  const active = isActive(run.status)

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

  function handleJobsOpen(open: boolean): void {
    setJobsOpen(open)
    if (open && (!jobsState.data || active)) void loadJobs()
  }

  const jobs = jobsState.data?.jobs ?? []
  const completedJobs = jobs.filter((job) => job.status === "completed").length
  const progress = jobs.length > 0 ? Math.round(completedJobs / jobs.length * 100) : null

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="pr-2">{run.displayTitle}</CardTitle>
        <CardDescription className="truncate">{run.name} #{run.runNumber}</CardDescription>
        <CardAction>
          <Badge variant={statusVariant(run.status, run.conclusion)}>
            {statusLabel(run.status, run.conclusion)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-3" />
            <span className="max-w-36 truncate">{run.branch || "unknown branch"}</span>
          </span>
          <span>{run.event}</span>
          <time dateTime={run.updatedAt} title={new Date(run.updatedAt).toLocaleString()}>
            {relativeTime(run.updatedAt)}
          </time>
        </div>

        {active && (
          <Progress
            value={progress}
            aria-label={progress === null ? `${run.name} is running` : `${run.name} is ${progress}% complete`}
            className="gap-0"
          />
        )}

        <Collapsible open={jobsOpen} onOpenChange={handleJobsOpen}>
          <div className="flex items-center gap-1">
            <CollapsibleTrigger
              render={<Button type="button" variant="ghost" size="xs" className="flex-1 justify-start" />}
            >
              <ChevronDown data-icon="inline-start" className={cn(jobsOpen && "rotate-180")} />
              {jobsOpen ? "Hide jobs" : "View jobs"}
            </CollapsibleTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${run.name} run on GitHub`}
              onClick={() => window.open(run.url, "_blank", "noopener,noreferrer")}
            >
              <ArrowUpRight />
            </Button>
          </div>
          <CollapsibleContent>
            <div className="flex flex-col gap-2 pt-2">
              {jobsState.loading && !jobsState.data && (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status">
                  <Spinner />
                  Loading jobs…
                </div>
              )}
              {jobsState.error && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Jobs unavailable</AlertTitle>
                  <AlertDescription>{jobsState.error.error}</AlertDescription>
                </Alert>
              )}
              {!jobsState.loading && !jobsState.error && jobsState.data && jobs.length === 0 && (
                <p className="py-2 text-xs text-muted-foreground">No jobs were reported for this run.</p>
              )}
              {jobs.map((job) => <JobDetails key={job.id} job={job} />)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
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

function WorkflowRunSummary({
  activeCount,
  passedCount,
  failedCount,
}: {
  activeCount: number
  passedCount: number
  failedCount: number
}) {
  return (
    <div className="grid shrink-0 grid-cols-3 divide-x border-b bg-muted/20 py-2">
      <div className="text-center">
        <div className="text-sm font-semibold tabular-nums">{activeCount}</div>
        <div className="text-[10px] text-muted-foreground">Active</div>
      </div>
      <div className="text-center">
        <div className="text-sm font-semibold tabular-nums">{passedCount}</div>
        <div className="text-[10px] text-muted-foreground">Passed</div>
      </div>
      <div className="text-center">
        <div className={cn("text-sm font-semibold tabular-nums", failedCount > 0 && "text-destructive")}>
          {failedCount}
        </div>
        <div className="text-[10px] text-muted-foreground">Failed</div>
      </div>
    </div>
  )
}

function WorkflowRunSection({
  id,
  title,
  runs,
  projectPath,
}: {
  id: string
  title: string
  runs: GitHubActionsRun[]
  projectPath: string
}) {
  if (runs.length === 0) return null
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-center gap-2">
        <h3 id={id} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <Separator className="flex-1" />
      </div>
      <div className="flex flex-col gap-2">
        {runs.map((run) => <RunCard key={run.id} run={run} projectPath={projectPath} />)}
      </div>
    </section>
  )
}

function WorkflowRunsBody({
  data,
  error,
  loading,
  projectPath,
  activeRuns,
  completedRuns,
  refresh,
}: {
  data: ReturnType<typeof useGitHubActions>["data"]
  error: ReturnType<typeof useGitHubActions>["error"]
  loading: boolean
  projectPath: string | null
  activeRuns: GitHubActionsRun[]
  completedRuns: GitHubActionsRun[]
  refresh: () => Promise<void>
}) {
  if (loading && !data) return <LoadingRuns />
  if (error && !data) {
    return (
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
    )
  }
  if (data && data.runs.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Workflow /></EmptyMedia>
          <EmptyTitle>No workflow runs</EmptyTitle>
          <EmptyDescription>GitHub has not reported any Actions runs for this repository.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!data || !projectPath) return null
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-3">
        <WorkflowRunSection
          id="active-workflow-runs"
          title="Active"
          runs={activeRuns}
          projectPath={projectPath}
        />
        <WorkflowRunSection
          id="recent-workflow-runs"
          title="Recent"
          runs={completedRuns}
          projectPath={projectPath}
        />
      </div>
    </ScrollArea>
  )
}

export function GitHubActionsPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const { data, error, loading, refreshing, refresh } = useGitHubActions(context.projectPath, active)
  const runs = data?.runs ?? []
  const activeRuns = runs.filter((run) => isActive(run.status))
  const completedRuns = runs.filter((run) => !isActive(run.status))
  const passedCount = completedRuns.filter((run) => run.conclusion === "success").length
  const failedCount = completedRuns.filter((run) => isFailed(run.conclusion)).length
  const projectPath = context.projectPath

  return (
    <section className="flex size-full min-h-0 flex-col" aria-label="GitHub Actions panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-muted">
          <Github className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">GitHub Actions</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {data?.repository ?? "Current repository"}
          </p>
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

      {data && (
        <WorkflowRunSummary
          activeCount={activeRuns.length}
          passedCount={passedCount}
          failedCount={failedCount}
        />
      )}

      <WorkflowRunsBody
        data={data}
        error={error}
        loading={loading}
        projectPath={projectPath}
        activeRuns={activeRuns}
        completedRuns={completedRuns}
        refresh={refresh}
      />
    </section>
  )
}
