import { useGitHubNavigation, Description } from "./navigation.js"
import { useMemo, useState, type ReactNode } from "react"
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheckBig,
  Clock3,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessagesSquare,
  TriangleAlert,
  User,
  X,
} from "lucide-react"
import type {
  GitHubMergeMethod,
  GitHubPullFile,
  GitHubPullFilesResponse,
  GitHubPullRequest,
  GitHubPullSession,
  GitHubPullState,
  GitHubPullsResponse,
} from "@cogpit/plugin-integrations"
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
  relativeTime,
  useNow,
  ClosedFold,
  CommentCount,
  FilterBar,
  TabEmpty,
} from "@cogpit/plugin-ui"
import { toErrorResponse, useGitHubDetails } from "./githubStore.js"
import { useExpandable, type LazyResourceState } from "./useExpandable.js"

type Filter = "all" | "mine" | "branch"

const STATE_LABEL: Record<GitHubPullState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
}

const RAIL_CLASS: Record<GitHubPullState, string> = {
  open: "bg-success",
  draft: "bg-border",
  merged: "bg-info",
  closed: "bg-destructive",
}

const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
}

/** GitHub's own wording for the button that performs each method. */
const CONFIRM_LABEL: Record<GitHubMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
}

export function isOpen(pull: GitHubPullRequest): boolean {
  return pull.state === "open" || pull.state === "draft"
}

/** GitHub would accept a merge as things stand. `behind` merges too unless protection insists on an up-to-date branch. */
function isMergeable(pull: GitHubPullRequest): boolean {
  return pull.mergeState === "clean" || pull.mergeState === "unstable" || pull.mergeState === "behind"
}

/** Something on an open pull request that the author has to deal with before it can land. */
export function needsAttention(pull: GitHubPullRequest): boolean {
  return isOpen(pull) && (pull.checks === "failure" || pull.review === "changes_requested" || pull.conflicts)
}

function StateGlyph({ state }: { state: GitHubPullState }) {
  const className = "size-3.5 shrink-0"
  const label = STATE_LABEL[state]
  if (state === "open") return <GitPullRequest className={cn(className, "text-success")} aria-label={label} />
  if (state === "draft") return <GitPullRequestDraft className={cn(className, "text-muted-foreground")} aria-label={label} />
  if (state === "merged") return <GitMerge className={cn(className, "text-info")} aria-label={label} />
  return <GitPullRequestClosed className={cn(className, "text-destructive")} aria-label={label} />
}

function checkCount(count: number): string {
  return count === 1 ? "1 check" : `${count} checks`
}

function checksLabel(pull: GitHubPullRequest): string {
  const progress = pull.checkProgress
  if (pull.checks === "success") return progress ? `${checkCount(progress.total)} passed` : "Checks passed"
  if (pull.checks === "failure") return "Checks failed"
  if (!progress) return "Checks running"
  return progress.total === 1 ? "Check running" : `${progress.completed} of ${progress.total} checks done`
}

/** A thin arc that fills as the head commit's checks report, for the wait between push and verdict. */
function ProgressRing({ fraction }: { fraction: number }) {
  const radius = 5
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, fraction))
  return (
    <svg viewBox="0 0 14 14" className="size-3 text-info" aria-hidden>
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform="rotate(-90 7 7)"
        className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  )
}

function ChecksGlyph({ pull }: { pull: GitHubPullRequest }) {
  if (pull.checks === "success") return <Check className="size-3 text-success" />
  if (pull.checks === "failure") return <X className="size-3 text-destructive" />
  const progress = pull.checkProgress
  if (progress && progress.total > 0) return <ProgressRing fraction={progress.completed / progress.total} />
  return <Clock3 className="size-3 text-info" />
}

/**
 * Checks that report from GitHub Actions have runs to show in the Actions tab.
 * Only checks known to come from elsewhere are sent to GitHub instead.
 */
export function checksOnActions(pull: GitHubPullRequest): boolean {
  if (!pull.checkProgress) return true
  return pull.checkProgress.actions
}

function reviewSignal(pull: GitHubPullRequest): { icon: ReactNode; label: string } | null {
  if (pull.reviewRequested) {
    return { icon: <Eye className="size-3 text-info" />, label: "Your review is requested" }
  }
  if (pull.review === "approved") {
    return { icon: <CircleCheckBig className="size-3 text-success" />, label: "Approved" }
  }
  if (pull.review === "changes_requested") {
    return { icon: <CircleAlert className="size-3 text-warning" />, label: "Changes requested" }
  }
  if (pull.review === "review_required" && isOpen(pull)) {
    return { icon: <Eye className="size-3 text-muted-foreground" />, label: "Review required" }
  }
  return null
}

/** Everything about a pull request that asks for attention, read left to right by urgency. */
function Signals({ pull, onShowChecks }: { pull: GitHubPullRequest; onShowChecks: (pull: GitHubPullRequest) => void }) {
  const review = reviewSignal(pull)
  const label = checksLabel(pull)

  return (
    <span className="flex h-5 shrink-0 items-center gap-1.5">
      {pull.checks && (
        <button
          type="button"
          className="rounded-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/20"
          aria-label={`${label}, ${checksOnActions(pull) ? "show runs" : "open on GitHub"}`}
          title={label}
          onClick={() => onShowChecks(pull)}
        >
          <ChecksGlyph pull={pull} />
        </button>
      )}
      {review && <span aria-label={review.label} title={review.label} role="img">{review.icon}</span>}
      {pull.conflicts && (
        <TriangleAlert className="size-3 text-warning" aria-label="Has merge conflicts" role="img" />
      )}
      <CommentCount count={pull.comments} />
    </span>
  )
}

/** One letter per file status, the way `git status --short` reads. */
function fileStatusMark(status: GitHubPullFile["status"]): { mark: string; className: string } {
  if (status === "added" || status === "copied") return { mark: "A", className: "text-success" }
  if (status === "removed") return { mark: "D", className: "text-destructive" }
  if (status === "renamed") return { mark: "R", className: "text-info" }
  return { mark: "M", className: "text-warning" }
}

function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/")
  return slash === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

function FileRow({ file }: { file: GitHubPullFile }) {
  const { mark, className } = fileStatusMark(file.status)
  const { directory, name } = splitPath(file.path)
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5 font-mono text-[11px] leading-5" title={file.path}>
      <span className={cn("w-3 shrink-0 text-center font-medium", className)} aria-label={file.status}>{mark}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{directory}</span>
        <span className={cn(file.status === "removed" && "line-through text-muted-foreground")}>{name}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums">
        {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && " "}
        {file.deletions > 0 && <span className="text-destructive">−{file.deletions}</span>}
      </span>
    </li>
  )
}

type FilesState = LazyResourceState<GitHubPullFilesResponse>

function PullDetails({ pull, files }: { pull: GitHubPullRequest; files: FilesState }) {
  const body = pull.body.trim()
  const list = files.data?.files ?? []
  return (
    <div className="flex flex-col gap-3 py-2 pl-[22px] pr-1">
      {body ? <Description body={body} /> : <p className="text-xs leading-5 text-muted-foreground">No description.</p>}

      <section aria-label="Files changed" className="min-w-0">
        <h4 className="flex items-center gap-1.5 text-[11px] font-medium leading-5">
          Files changed
          {files.data && (
            <span className="font-mono text-[10px] font-normal text-muted-foreground tabular-nums">
              {files.data.truncated ? `${list.length}+` : list.length}
            </span>
          )}
        </h4>
        {files.loading && !files.data && (
          <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground" role="status">
            <Spinner className="size-3" />
            Loading files
          </div>
        )}
        {files.error && <p className="py-1 text-[11px] text-destructive">{files.error.error}</p>}
        {files.data && list.length === 0 && (
          <p className="py-1 text-[11px] text-muted-foreground">No file changes on this pull request.</p>
        )}
        {list.length > 0 && (
          <ul className="border-l border-border pl-2">
            {list.map((file) => <FileRow key={file.path} file={file} />)}
          </ul>
        )}
        {files.data?.truncated && (
          <p className="py-1 text-[11px] text-muted-foreground">
            GitHub lists the first {list.length} files here. The full set is on the pull request.
          </p>
        )}
      </section>

      <Button
        variant="outline"
        size="xs"
        className="self-start"
        render={<a href={pull.url} target="_blank" rel="noopener noreferrer" />}
      >
        Open pull request on GitHub
        <ArrowUpRight data-icon="inline-end" />
      </Button>
    </div>
  )
}

function SessionChips({
  sessions,
  openSession,
}: {
  sessions: GitHubPullSession[]
  openSession: ((handle: string) => void) | undefined
}) {
  return (
    <div className="flex flex-wrap gap-1 pl-[26px] pr-1 pb-1" aria-label="Sessions on this pull request">
      {sessions.map((session) => (
        <button
          key={session.handle}
          type="button"
          className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-default disabled:hover:border-border disabled:hover:text-muted-foreground"
          onClick={() => openSession?.(session.handle)}
          disabled={!openSession}
          aria-label={`Open session: ${session.title || session.handle}`}
          title={session.title || session.handle}
        >
          <MessagesSquare className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{session.title || session.handle.slice(0, 8)}</span>
        </button>
      ))}
    </div>
  )
}

function mergeCaveat(pull: GitHubPullRequest): string | null {
  if (pull.mergeState === "unstable") return "Some checks did not pass."
  if (pull.mergeState === "behind") return `The branch is behind ${pull.baseBranch}; GitHub merges it as it stands.`
  return null
}

/** The one place a merge happens: choose a method the repository allows, then confirm. */
function MergeStrip({
  pull,
  projectKey,
  methods,
  onCancel,
  onMerged,
}: {
  pull: GitHubPullRequest
  projectKey: string
  methods: GitHubMergeMethod[]
  onCancel: () => void
  onMerged: () => void
}) {
  const { mergePull } = useGitHubDetails()
  const [method, setMethod] = useState<GitHubMergeMethod>(methods[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const caveat = mergeCaveat(pull)

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await mergePull(projectKey, pull.number, method, pull.headSha)
      if (result.merged) { onMerged(); return }
      setError(result.message || "GitHub did not merge the pull request.")
    } catch (failure) {
      setError(toErrorResponse(failure, "Unable to merge this pull request.").error)
    }
    setBusy(false)
  }

  return (
    <div
      role="group"
      aria-label={`Merge #${pull.number}`}
      className="mx-1 mb-1 ml-[22px] flex flex-wrap items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1.5"
    >
      <span className="text-[11px] text-muted-foreground">
        Merge into <span className="font-mono text-foreground">{pull.baseBranch}</span>
      </span>
      {methods.length > 1 && (
        <span className="flex items-center gap-0.5" role="radiogroup" aria-label="Merge method">
          {methods.map((candidate) => (
            <FilterChip
              key={candidate}
              pressed={candidate === method}
              role="radio"
              aria-checked={candidate === method}
              disabled={busy}
              onClick={() => setMethod(candidate)}
            >
              {METHOD_LABEL[candidate]}
            </FilterChip>
          ))}
        </span>
      )}
      <span className="min-w-2 flex-1" />
      <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" size="xs" disabled={busy} onClick={() => { void confirm() }}>
        {busy ? <Spinner data-icon="inline-start" /> : <GitMerge data-icon="inline-start" />}
        {busy ? "Merging…" : CONFIRM_LABEL[method]}
      </Button>
      {caveat && !error && <p className="w-full text-[11px] leading-4 text-warning">{caveat}</p>}
      {error && <p role="alert" className="w-full text-[11px] leading-4 text-destructive">{error}</p>}
    </div>
  )
}

interface PullRowProps {
  pull: GitHubPullRequest
  projectKey: string
  currentBranch: string | null
  sessions: GitHubPullSession[]
  mergeMethods: GitHubMergeMethod[]
  openSession: ((handle: string) => void) | undefined
  onShowChecks: (pull: GitHubPullRequest) => void
  onMerged: () => void
  now: number
  /** Start expanded, for a view with a single pull request worth reading in full. */
  expanded?: boolean
}

function PullRow({ pull, projectKey, currentBranch, sessions, mergeMethods, openSession, onShowChecks, onMerged, now, expanded = false }: PullRowProps) {
  const openExternal = useGitHubNavigation()
  const { pullFiles: fetchGitHubPullFiles } = useGitHubDetails()
  const { open, state: files, onOpenChange } = useExpandable(
    () => fetchGitHubPullFiles(projectKey, pull.number),
    "Unable to load changed files",
    false,
    expanded,
  )
  const [merging, setMerging] = useState(false)
  // Holds the row's look between the merge and the refreshed list that confirms it.
  const [merged, setMerged] = useState(false)
  const onCurrentBranch = currentBranch !== null && pull.headBranch === currentBranch
  const activity = isOpen(pull) ? pull.updatedAt : (pull.closedAt ?? pull.updatedAt)
  const canMerge = !merged && isMergeable(pull) && mergeMethods.length > 0
  const state: GitHubPullState = merged && isOpen(pull) ? "merged" : pull.state

  return (
    <article className="relative rounded-md bg-card py-2 pl-3 pr-2" aria-label={pull.title}>
      <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", RAIL_CLASS[state])} />
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="group/pull flex items-start gap-1 pr-1">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 flex-col rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
            aria-label={`${pull.title} #${pull.number}: ${STATE_LABEL[state]}`}
            aria-expanded={open}
          >
            <span className="flex min-w-0 items-center gap-2">
              <StateGlyph state={state} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium leading-5",
                  !isOpen(pull) && "text-muted-foreground",
                )}
              >
                {pull.title}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{pull.number}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[11px] leading-4 text-muted-foreground">
              {pull.author && <span className="shrink-0">{pull.author}</span>}
              <span className="flex min-w-0 items-center gap-1 font-mono">
                {onCurrentBranch && <GitBranch className="size-3 shrink-0 text-foreground" aria-label="Current branch" />}
                <span className={cn("truncate", onCurrentBranch && "text-foreground")}>{pull.headBranch}</span>
                <ArrowRight className="size-3 shrink-0" aria-hidden />
                <span className="max-w-24 shrink-0 truncate">{pull.baseBranch}</span>
              </span>
              <span className="shrink-0">·</span>
              <time className="shrink-0" dateTime={activity} title={new Date(activity).toLocaleString()}>
                {relativeTime(activity, now)}
              </time>
            </span>
          </CollapsibleTrigger>
          <div className="mt-1 flex shrink-0 flex-col items-end gap-0.5">
            <div className="flex items-center gap-1">
              <Signals pull={pull} onShowChecks={onShowChecks} />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/pull:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                aria-label={`Open #${pull.number} on GitHub`}
                onClick={() => openExternal?.(pull.url)}
              >
                <ArrowUpRight />
              </Button>
            </div>
            {canMerge && !merging && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mr-1 h-5 gap-1 px-1.5 text-[10px]"
                aria-label={`Merge #${pull.number}`}
                onClick={() => setMerging(true)}
              >
                <GitMerge className="size-3" />
                Merge
              </Button>
            )}
          </div>
        </div>
        {merging && canMerge && (
          <MergeStrip
            pull={pull}
            projectKey={projectKey}
            methods={mergeMethods}
            onCancel={() => setMerging(false)}
            onMerged={() => { setMerging(false); setMerged(true); onMerged() }}
          />
        )}
        {sessions.length > 0 && <SessionChips sessions={sessions} openSession={openSession} />}
        <CollapsibleContent>
          <PullDetails pull={pull} files={files} />
        </CollapsibleContent>
      </Collapsible>
    </article>
  )
}

function applyFilter(pulls: readonly GitHubPullRequest[], filter: Filter, data: GitHubPullsResponse): GitHubPullRequest[] {
  if (filter === "mine") return pulls.filter((pull) => pull.author === data.viewer)
  if (filter === "branch") return pulls.filter((pull) => pull.headBranch === data.branch)
  return [...pulls]
}

/** Sessions keyed by the pull request numbers they touched, newest session first. */
export function sessionsByPull(sessions: readonly GitHubPullSession[]): Map<number, GitHubPullSession[]> {
  const map = new Map<number, GitHubPullSession[]>()
  for (const session of sessions) {
    for (const number of session.numbers) {
      const list = map.get(number)
      if (list) list.push(session)
      else map.set(number, [session])
    }
  }
  return map
}

/**
 * The pull requests one session opened or worked on, open ones first. Empty
 * when the session is unknown or touched nothing in the loaded list.
 */
export function sessionPullRequests(
  pulls: readonly GitHubPullRequest[],
  sessions: readonly GitHubPullSession[],
  handle: string | null,
): GitHubPullRequest[] {
  if (!handle) return []
  const numbers = new Set(sessions.filter((session) => session.handle === handle).flatMap((session) => session.numbers))
  const mine = pulls.filter((pull) => numbers.has(pull.number))
  return [...mine.filter(isOpen), ...mine.filter((pull) => !isOpen(pull))]
}

interface PullListProps {
  data: GitHubPullsResponse
  sessions: readonly GitHubPullSession[]
  projectKey: string
  openSession: ((handle: string) => void) | undefined
  onShowChecks: (pull: GitHubPullRequest) => void
  onMerged: () => void
}

interface SessionPullListProps extends PullListProps {
  pulls: readonly GitHubPullRequest[]
}

/** The open session's pull requests, laid out to be read rather than scanned. */
export function SessionPullRequestsTab({
  pulls,
  data,
  sessions,
  projectKey,
  openSession,
  onShowChecks,
  onMerged,
}: SessionPullListProps) {
  const now = useNow(false)
  const linked = useMemo(() => sessionsByPull(sessions), [sessions])

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-3 py-3" aria-label="Pull requests from this session">
        <p className="px-1 text-[11px] leading-4 text-muted-foreground">Opened or worked on in this session.</p>
        {pulls.map((pull) => (
          <PullRow
            key={pull.number}
            pull={pull}
            projectKey={projectKey}
            currentBranch={data.branch}
            sessions={linked.get(pull.number) ?? []}
            mergeMethods={data.mergeMethods}
            openSession={openSession}
            onShowChecks={onShowChecks}
            onMerged={onMerged}
            now={now}
            expanded={pulls.length === 1}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

export function PullRequestsTab({
  data,
  sessions,
  projectKey,
  openSession,
  onShowChecks,
  onMerged,
}: PullListProps) {
  const [filter, setFilter] = useState<Filter>("all")
  const now = useNow(false)
  const linked = useMemo(() => sessionsByPull(sessions), [sessions])

  const mineCount = data.viewer ? data.pulls.filter((pull) => pull.author === data.viewer).length : 0
  const branchCount = data.branch ? data.pulls.filter((pull) => pull.headBranch === data.branch).length : 0
  const effectiveFilter: Filter = (filter === "mine" && mineCount === 0) || (filter === "branch" && branchCount === 0)
    ? "all"
    : filter
  const visible = applyFilter(data.pulls, effectiveFilter, data)
  const open = visible.filter(isOpen)
  const closed = visible.filter((pull) => !isOpen(pull))

  if (data.pulls.length === 0) {
    return (
      <TabEmpty
        icon={GitPullRequest}
        title="No pull requests yet"
        description="Open one from a branch and it will show up here."
      />
    )
  }

  const row = (pull: GitHubPullRequest) => (
    <PullRow
      key={pull.number}
      pull={pull}
      projectKey={projectKey}
      currentBranch={data.branch}
      sessions={linked.get(pull.number) ?? []}
      mergeMethods={data.mergeMethods}
      openSession={openSession}
      onShowChecks={onShowChecks}
      onMerged={onMerged}
      now={now}
    />
  )

  return (
    <>
      <FilterBar label="Filter pull requests">
        <FilterChip pressed={effectiveFilter === "all"} onClick={() => setFilter("all")}>
          All
          <FilterChipCount>{data.pulls.length}</FilterChipCount>
        </FilterChip>
        {data.viewer && (
          <FilterChip
            pressed={effectiveFilter === "mine"}
            disabled={mineCount === 0}
            onClick={() => setFilter("mine")}
            aria-label={`Only pull requests by ${data.viewer}`}
          >
            <User className="size-3" />
            Mine
            <FilterChipCount>{mineCount}</FilterChipCount>
          </FilterChip>
        )}
        {data.branch && (
          <FilterChip
            pressed={effectiveFilter === "branch"}
            disabled={branchCount === 0}
            onClick={() => setFilter("branch")}
            aria-label={`Only pull requests from ${data.branch}`}
          >
            <GitBranch className="size-3" />
            <span className="max-w-28 truncate">{data.branch}</span>
            <FilterChipCount>{branchCount}</FilterChipCount>
          </FilterChip>
        )}
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          {open.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">Nothing open right now.</p>
          ) : (
            open.map(row)
          )}

          {closed.length > 0 && <ClosedFold count={closed.length}>{closed.map(row)}</ClosedFold>}
        </div>
      </ScrollArea>
    </>
  )
}
