import { useEffect, useMemo, useState } from "react"
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  CircleMinus,
  Clock3,
  GitBranch,
  Workflow,
  X,
} from "lucide-react"
import type {
  GitHubActionsJob,
  GitHubActionsRun,
  GitHubActionsRunsResponse,
  GitHubActionsStep,
  GitHubWorkflowConclusion,
  GitHubWorkflowStatus,
} from "../../shared/contracts/github"
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FilterChip,
  FilterChipCount,
  ScrollArea,
  Spinner,
} from "@/plugin-api"
import { fetchGitHubActionsJobs } from "./githubStore"
import { FilterBar, TabEmpty } from "./parts"
import { duration, relativeTime, useNow } from "./time"
import { useExpandable } from "./useExpandable"

/** Visual weight of a run, from the one that needs attention to the one that needs none. */
type Tone = "live" | "fail" | "pass" | "quiet"
type Filter = "all" | "failed" | { branch: string }

export function isActive(status: GitHubWorkflowStatus): boolean {
  return status !== "completed"
}

export function isFailed(conclusion: GitHubWorkflowConclusion): boolean {
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

function RunRow({ run, projectPath, now }: { run: GitHubActionsRun; projectPath: string; now: number }) {
  const tone = toneOf(run.status, run.conclusion)
  const active = tone === "live"
  // A running job list keeps changing, so reload it on every reopen.
  const { open, state: jobsState, onOpenChange } = useExpandable(
    () => fetchGitHubActionsJobs(projectPath, run.id),
    "Unable to load workflow jobs",
    active,
  )

  const jobs = jobsState.data?.jobs ?? []
  const elapsed = duration(run.createdAt, active ? null : run.updatedAt, now)

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
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

function applyFilter(runs: readonly GitHubActionsRun[], filter: Filter): GitHubActionsRun[] {
  if (filter === "failed") return runs.filter((run) => isFailed(run.conclusion))
  if (filter === "all") return [...runs]
  return runs.filter((run) => run.branch === filter.branch)
}

function emptyFilterMessage(filter: Filter, branch: string | null): string {
  if (filter === "failed") return "Nothing failed in the latest runs."
  if (filter === "all") return `No recent runs on ${branch}.`
  return `No recent runs on ${filter.branch}.`
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
  const runs = useMemo(() => applyFilter(data.runs, filter), [data, filter])
  const groups = useMemo(() => groupRunsByCommit(runs), [runs])
  const now = useNow(groups.some((group) => group.tone === "live"))

  if (data.runs.length === 0) {
    return (
      <TabEmpty
        icon={Workflow}
        title="No workflow runs yet"
        description="Push a commit that triggers a workflow and it will show up here."
      />
    )
  }
  if (groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        {emptyFilterMessage(filter, data.branch)}
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

/** A branch another view asked to see. A fresh object re-applies the same branch. */
export interface BranchFocus {
  branch: string
}

export function ActionsTab({
  data,
  projectPath,
  focus,
}: {
  data: GitHubActionsRunsResponse
  projectPath: string
  focus: BranchFocus | null
}) {
  const [filter, setFilter] = useState<Filter>("all")
  useEffect(() => {
    if (focus) setFilter({ branch: focus.branch })
  }, [focus])

  const runs = data.runs
  const failedCount = runs.filter((run) => isFailed(run.conclusion)).length
  const branch = data.branch
  const branchCount = branch ? runs.filter((run) => run.branch === branch).length : 0
  // A branch chip only exists for the checked-out branch; an asked-for branch gets its own.
  const focused = typeof filter === "object" && filter.branch !== branch ? filter.branch : null
  const branchFilter = typeof filter === "object" && !focused
  const effectiveFilter: Filter = (branchFilter && !branch) || (filter === "failed" && failedCount === 0)
    ? "all"
    : filter

  return (
    <>
      {runs.length > 0 && (
        <FilterBar label="Filter runs">
          <FilterChip pressed={effectiveFilter === "all"} onClick={() => setFilter("all")}>
            All
            <FilterChipCount>{runs.length}</FilterChipCount>
          </FilterChip>
          {branch && (
            <FilterChip
              pressed={branchFilter && effectiveFilter !== "all"}
              disabled={branchCount === 0}
              onClick={() => setFilter({ branch })}
              aria-label={`Only runs on ${branch}`}
            >
              <GitBranch className="size-3" />
              <span className="max-w-28 truncate">{branch}</span>
              <FilterChipCount>{branchCount}</FilterChipCount>
            </FilterChip>
          )}
          {focused && (
            <FilterChip pressed onClick={() => setFilter("all")} aria-label={`Only runs on ${focused}`}>
              <GitBranch className="size-3" />
              <span className="max-w-28 truncate">{focused}</span>
              <FilterChipCount>{runs.filter((run) => run.branch === focused).length}</FilterChipCount>
              <X className="size-3" aria-hidden />
            </FilterChip>
          )}
          <FilterChip
            pressed={effectiveFilter === "failed"}
            disabled={failedCount === 0}
            onClick={() => setFilter("failed")}
          >
            <span className={cn(failedCount > 0 && "text-destructive")}>Failed</span>
            {" "}
            <FilterChipCount>{failedCount}</FilterChipCount>
          </FilterChip>
        </FilterBar>
      )}
      <RunsLedger data={data} filter={effectiveFilter} projectPath={projectPath} />
    </>
  )
}
