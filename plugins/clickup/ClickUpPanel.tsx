import { useState, type FormEvent, type ReactNode } from "react"
import { AlertCircle, ArrowUpRight, KeyRound, RefreshCw, X } from "lucide-react"
import type { ClickUpErrorResponse } from "../../shared/contracts/clickup"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  cn,
  Input,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type WorkspacePanelProps,
} from "@/plugin-api"
import {
  forgetClickUpToken,
  saveClickUpToken,
  toErrorResponse,
  useClickUpListTasks,
  useClickUpMyTasks,
  useClickUpStatus,
  type ClickUpResourceState,
} from "./clickupStore"
import { isFinished, isOverdue } from "./filters"
import { LinkProject, ProjectTab } from "./ProjectTab"
import { TaskList } from "./TaskList"

type Tab = "mine" | "project"

const TOKEN_HELP_URL = "https://app.clickup.com/settings/apps"

function isTab(value: unknown): value is Tab {
  return value === "mine" || value === "project"
}

function errorHelp(error: ClickUpErrorResponse): string {
  if (error.code === "clickup_auth_failed") return "Generate a new personal token in ClickUp and add it again."
  if (error.code === "clickup_rate_limited") return "ClickUp allows 100 requests a minute per token; the panel retries on its own."
  return "Check your ClickUp access, then try again."
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-5 px-3 py-4" aria-label={label}>
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex flex-col gap-2 border-l-2 border-border pl-3">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
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
  state: ClickUpResourceState<T>
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

/** First run: collect the personal token. Shown until the server confirms one. */
export function TokenSetup({ error: standingError }: { error: ClickUpErrorResponse | null }) {
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await saveClickUpToken(token.trim())
      setToken("")
    } catch (failure) {
      setError(toErrorResponse(failure, "Unable to save the token").error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-4 p-4" onSubmit={(event) => { void submit(event) }} aria-label="Connect ClickUp">
      <div>
        <h3 className="text-sm font-medium">Connect ClickUp</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Paste a personal API token. Cogpit keeps it on this machine, in <code className="font-mono">~/.cogpit/clickup.json</code>, and never shows it again. A <code className="font-mono">CLICKUP_API_TOKEN</code> in the server environment works too.
        </p>
      </div>
      {standingError && standingError.code !== "clickup_not_configured" && (
        <p role="alert" className="text-xs text-destructive">{standingError.error}</p>
      )}
      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-medium text-muted-foreground" htmlFor="clickup-token">Personal API token</label>
        <Input
          id="clickup-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="pk_…"
          className="h-8 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !token.trim()}>
          {busy ? <Spinner /> : <KeyRound data-icon="inline-start" />}
          Connect
        </Button>
        <Button variant="outline" size="sm" render={<a href={TOKEN_HELP_URL} target="_blank" rel="noopener noreferrer" />}>
          Get a token
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </div>
    </form>
  )
}

function TabCount({ value, attention }: { value: number | null; attention?: boolean }) {
  if (value === null || value === 0) return null
  return (
    <span className={cn("font-mono text-[10px] tabular-nums", attention ? "text-destructive" : "text-muted-foreground")}>
      {value}
    </span>
  )
}

export function ClickUpIndicator() {
  const status = useClickUpStatus(true)
  const { data } = useClickUpMyTasks(status.data?.configured === true)
  const now = Date.now()
  const overdue = data?.tasks.filter((task) => isOverdue(task, now)).length ?? 0
  if (overdue === 0) return null
  return (
    <Badge
      variant="destructive"
      className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]"
      aria-label={`${overdue} overdue ClickUp task${overdue === 1 ? "" : "s"}`}
    >
      {overdue}
    </Badge>
  )
}

export function ClickUpPanel({ context, active, closePanel }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("mine")
  const projectPath = context.projectPath
  const status = useClickUpStatus(active)
  const configured = status.data?.configured === true
  const mine = useClickUpMyTasks(active && configured)
  const project = useClickUpListTasks(projectPath, active && configured && tab === "project")
  const current = tab === "mine" ? mine : project
  const now = Date.now()
  const overdue = mine.data ? mine.data.tasks.filter((task) => isOverdue(task, now)).length : null
  const openMine = mine.data ? mine.data.tasks.length : null
  const workspace = status.data?.workspace ?? null

  let body: ReactNode
  if (status.data === null && status.error === null) {
    body = <LoadingRows label="Checking ClickUp connection" />
  } else if (!configured) {
    body = <TokenSetup error={status.error} />
  } else {
    body = (
      <>
        <div className="flex h-9 shrink-0 items-end border-b px-3">
          <TabsList variant="line" className="h-full gap-3 p-0" aria-label="ClickUp views">
            <TabsTrigger value="mine" className="h-full flex-none rounded-none px-0 text-xs">
              My tasks
              <TabCount value={overdue || openMine} attention={Boolean(overdue)} />
            </TabsTrigger>
            <TabsTrigger value="project" className="h-full flex-none rounded-none px-0 text-xs" disabled={!projectPath}>
              This project
              <TabCount value={project.data ? project.data.tasks.filter((task) => !isFinished(task)).length : null} />
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <TabsContent value="mine" className="flex min-h-0 flex-col">
            <ResourceFrame state={mine} loadingLabel="Loading your tasks" onRetry={() => { void mine.refresh() }}>
              {(data) => (
                <TaskList
                  tasks={data.tasks}
                  viewer={data.viewer}
                  composePrompt={context.composePrompt}
                  emptyTitle="Nothing assigned to you"
                  emptyDescription="Open tasks assigned to you anywhere in the workspace will show up here."
                  truncated={data.truncated}
                />
              )}
            </ResourceFrame>
          </TabsContent>
          <TabsContent value="project" className="flex min-h-0 flex-col">
            {projectPath && (project.error?.code === "project_unlinked" ? (
              <LinkProject projectPath={projectPath} onLinked={() => { void project.refresh() }} />
            ) : (
              <ResourceFrame state={project} loadingLabel="Loading the linked list" onRetry={() => { void project.refresh() }}>
                {(data) => (
                  <ProjectTab
                    data={data}
                    projectPath={projectPath}
                    composePrompt={context.composePrompt}
                    onUnlinked={() => { void project.refresh() }}
                  />
                )}
              </ResourceFrame>
            ))}
          </TabsContent>
        </div>
      </>
    )
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => { if (isTab(value)) setTab(value) }}
      className="size-full min-h-0 gap-0"
      aria-label="ClickUp panel"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium leading-tight">ClickUp</h2>
          {workspace ? (
            <a
              href={`https://app.clickup.com/${workspace.id}/home`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              <span className="truncate">{workspace.name}{status.data?.viewer ? ` · ${status.data.viewer.username}` : ""}</span>
              <ArrowUpRight className="size-3 shrink-0" />
            </a>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">Not connected</p>
          )}
        </div>
        {configured && !status.data?.tokenFromEnv && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => { void forgetClickUpToken() }}
            aria-label="Disconnect ClickUp"
            title="Disconnect ClickUp"
          >
            <KeyRound />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => { void (configured ? current.refresh() : status.refresh()) }}
          disabled={current.loading || current.refreshing || status.loading}
          aria-label={tab === "mine" ? "Refresh my tasks" : "Refresh project tasks"}
        >
          {current.refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close ClickUp">
          <X />
        </Button>
      </header>
      {body}
    </Tabs>
  )
}
