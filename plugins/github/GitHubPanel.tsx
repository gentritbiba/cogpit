import { useState, type ReactNode } from "react"
import { AlertCircle, ArrowUpRight, RefreshCw, X } from "lucide-react"
import type { GitHubErrorResponse } from "../../shared/contracts/github"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  cn,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type WorkspacePanelIndicatorProps,
  type WorkspacePanelProps,
} from "@/plugin-api"
import { ActionsTab, isActive, isFailed, type BranchFocus } from "./ActionsTab"
import { IssuesTab } from "./IssuesTab"
import { PullRequestsTab, isOpen } from "./PullRequestsTab"
import {
  useGitHubActions,
  useGitHubIssues,
  useGitHubPulls,
  useGitHubPullSessions,
  type GitHubResourceState,
} from "./githubStore"

type Tab = "actions" | "pulls" | "issues"

const REFRESH_LABEL: Record<Tab, string> = {
  actions: "Refresh GitHub Actions",
  pulls: "Refresh pull requests",
  issues: "Refresh issues",
}

function isTab(value: unknown): value is Tab {
  return value === "actions" || value === "pulls" || value === "issues"
}

function errorHelp(error: GitHubErrorResponse): string {
  if (error.code === "gh_missing") return "Install GitHub CLI, then refresh this panel."
  if (error.code === "gh_auth_required") return "Run `gh auth login` on the Cogpit host, then refresh."
  if (error.code === "no_github_remote") return "Add a GitHub origin remote to this repository."
  return "Check the repository and your GitHub access, then try again."
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-5 px-3 py-4" aria-label={label}>
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

function ResourceFrame<T>({
  state,
  loadingLabel,
  onRetry,
  children,
}: {
  state: GitHubResourceState<T>
  loadingLabel: string
  onRetry: () => void
  children: (data: T) => ReactNode
}) {
  if (state.data) return <>{children(state.data)}</>
  if (state.error) {
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{state.error.error}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{errorHelp(state.error)}</span>
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RefreshCw data-icon="inline-start" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  return <LoadingRows label={loadingLabel} />
}

function TabCount({ value, attention }: { value: number | null; attention?: boolean }) {
  if (value === null || value === 0) return null
  return (
    <span className={cn("font-mono text-[10px] tabular-nums", attention ? "text-info" : "text-muted-foreground")}>
      {value}
    </span>
  )
}

export function GitHubIndicator({ context }: WorkspacePanelIndicatorProps) {
  const enabled = context.projectPath !== null
  const { data } = useGitHubActions(context.projectPath, enabled)
  const pulls = useGitHubPulls(context.projectPath, enabled)
  const activeCount = data?.runs.filter((run) => isActive(run.status)).length ?? 0
  const latestFailed = data?.runs[0]?.conclusion ? isFailed(data.runs[0].conclusion) : false
  const reviewCount = pulls.data?.pulls.filter((pull) => isOpen(pull) && pull.reviewRequested).length ?? 0

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
  if (reviewCount > 0) {
    return (
      <Badge
        variant="secondary"
        className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]"
        aria-label={`${reviewCount} pull request${reviewCount === 1 ? "" : "s"} waiting for your review`}
      >
        {reviewCount}
      </Badge>
    )
  }
  return null
}

export function GitHubPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("actions")
  const [focus, setFocus] = useState<BranchFocus | null>(null)
  const projectPath = context.projectPath
  const runs = useGitHubActions(projectPath, active)
  const pulls = useGitHubPulls(projectPath, active)
  const pullSessions = useGitHubPullSessions(projectPath, active && tab === "pulls")
  const issues = useGitHubIssues(projectPath, active && tab === "issues")
  const current = { actions: runs, pulls, issues }[tab]

  function showChecks(branch: string): void {
    setFocus({ branch })
    setTab("actions")
  }
  const repository = runs.data ?? pulls.data ?? issues.data
  const activeRuns = runs.data ? runs.data.runs.filter((run) => isActive(run.status)).length : null
  const openPulls = pulls.data ? pulls.data.pulls.filter(isOpen).length : null
  const openIssues = issues.data ? issues.data.issues.filter((issue) => issue.state === "open").length : null

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => { if (isTab(value)) setTab(value) }}
      className="size-full min-h-0 gap-0"
      aria-label="GitHub panel"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">GitHub</h2>
          {/* Each tab id doubles as its path on GitHub. */}
          {repository ? (
            <a
              href={`${repository.repositoryUrl}/${tab}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              <span className="truncate">{repository.repository}</span>
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
          onClick={() => { void current.refresh() }}
          disabled={current.loading || current.refreshing || !projectPath}
          aria-label={REFRESH_LABEL[tab]}
        >
          {current.refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close GitHub">
          <X />
        </Button>
      </header>

      <div className="flex h-9 shrink-0 items-end border-b px-3">
        <TabsList variant="line" className="h-full gap-3 p-0" aria-label="GitHub views">
          <TabsTrigger value="actions" className="h-full flex-none rounded-none px-0 text-xs">
            Actions
            <TabCount value={activeRuns} attention />
          </TabsTrigger>
          <TabsTrigger value="pulls" className="h-full flex-none rounded-none px-0 text-xs">
            Pull requests
            <TabCount value={openPulls} />
          </TabsTrigger>
          <TabsTrigger value="issues" className="h-full flex-none rounded-none px-0 text-xs">
            Issues
            <TabCount value={openIssues} />
          </TabsTrigger>
        </TabsList>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <TabsContent value="actions" className="flex min-h-0 flex-col">
          <ResourceFrame state={runs} loadingLabel="Loading workflow runs" onRetry={() => { void runs.refresh() }}>
            {(data) => projectPath && <ActionsTab data={data} projectPath={projectPath} focus={focus} />}
          </ResourceFrame>
        </TabsContent>
        <TabsContent value="pulls" className="flex min-h-0 flex-col">
          <ResourceFrame state={pulls} loadingLabel="Loading pull requests" onRetry={() => { void pulls.refresh() }}>
            {(data) => projectPath && (
              <PullRequestsTab
                data={data}
                sessions={pullSessions.data?.sessions ?? []}
                projectPath={projectPath}
                openSession={context.openSession}
                onShowChecks={showChecks}
              />
            )}
          </ResourceFrame>
        </TabsContent>
        <TabsContent value="issues" className="flex min-h-0 flex-col">
          <ResourceFrame state={issues} loadingLabel="Loading issues" onRetry={() => { void issues.refresh() }}>
            {(data) => (
              <IssuesTab data={data} composePrompt={context.composePrompt} onShowPulls={() => setTab("pulls")} />
            )}
          </ResourceFrame>
        </TabsContent>
      </div>
    </Tabs>
  )
}
