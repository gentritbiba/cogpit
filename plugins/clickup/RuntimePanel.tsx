import { useState, type ReactNode } from "react"
import { AlertCircle, ArrowUpRight, RefreshCw } from "lucide-react"
import type { PluginClient, PluginContext } from "@cogpit/plugin-sdk"
import { Alert, AlertDescription, AlertTitle, Button, Skeleton, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@cogpit/plugin-ui"
import type { ClickUpErrorResponse } from "@cogpit/plugin-integrations"
import { isFinished, isOverdue, locationLabel } from "./filters.js"
import { TaskList } from "./TaskList.js"
import { useRuntimeResource, type ClickUpRuntimeStore, type ResourceState } from "./runtimeStore.js"

function SetupMessage({ project = false }: { project?: boolean }) {
  return <div className="flex flex-col gap-2 p-4">
    <h3 className="text-sm font-medium">{project ? "Link this project to a ClickUp list" : "Connect ClickUp"}</h3>
    <p className="text-xs leading-5 text-muted-foreground">{project
      ? "Use Connections above this panel to choose the workspace, space and list for this project."
      : "Use Connections above this panel to connect your ClickUp account and choose a workspace."}</p>
  </div>
}
function LoadingRows({ label }: { label: string }) {
  return <div className="flex flex-col gap-5 px-3 py-4" aria-label={label}>{[0, 1, 2].map((id) => <div key={id} className="flex flex-col gap-2 border-l-2 border-border pl-3"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-2.5 w-1/2" /></div>)}</div>
}
function ResourceFrame<T>({ state, retry, children }: { state: ResourceState<T>; retry: () => void; children: (value: T) => ReactNode }) {
  if (state.data) return <>{state.error && <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">Refresh failed. Showing previously loaded tasks.</p>}{children(state.data)}</>
  if (state.error?.code === "project_unlinked") return <SetupMessage project />
  if (state.error) return <div className="p-3"><Alert variant="destructive"><AlertCircle /><AlertTitle>{state.error.error}</AlertTitle><AlertDescription><Button variant="outline" size="xs" onClick={retry}><RefreshCw />Try again</Button></AlertDescription></Alert></div>
  return <LoadingRows label="Loading ClickUp tasks" />
}

export function RuntimePanel({ client, context, store }: { client: PluginClient; context: PluginContext; store: ClickUpRuntimeStore }) {
  const [tab, setTab] = useState<"mine" | "project">("mine")
  const [actionError, setActionError] = useState<string | null>(null)
  const status = useRuntimeResource(store.status, context.visible)
  const configured = status.data?.configured === true
  const mine = useRuntimeResource(store.mine, context.visible && configured)
  const project = useRuntimeResource(store.project, context.visible && configured && !!context.project && tab === "project")
  const current = tab === "mine" ? mine : project
  const workspace = status.data?.workspace
  const overdue = mine.data?.tasks.filter((task) => isOverdue(task, Date.now())).length ?? 0
  const runAction = (action: () => Promise<unknown>, fallback: string) => {
    setActionError(null)
    void action().catch((failure: unknown) => {
      if (failure && typeof failure === "object" && "code" in failure && failure.code === "CANCELED") return
      setActionError(fallback)
    })
  }
  const openExternal = (url: string) => runAction(() => client.navigation.openExternal(url), "Unable to open that link. Check the plugin's navigation permission.")
  const composePrompt = (text: string) => runAction(() => client.composer.append(text), "Unable to add this task to your draft. Check the plugin's composer permission.")
  const statusError: ClickUpErrorResponse | null = status.error
  return <Tabs value={tab} onValueChange={(value) => { if (value === "mine" || value === "project") setTab(value) }} className="size-full min-h-0 gap-0" aria-label="ClickUp panel">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
      <div className="min-w-0 flex-1"><h2 className="text-sm font-medium leading-tight">ClickUp</h2>{workspace
        ? <button type="button" className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-muted-foreground hover:text-foreground" onClick={() => openExternal(`https://app.clickup.com/${workspace.id}/home`)}><span className="truncate">{workspace.name}{status.data?.viewer ? ` · ${status.data.viewer.username}` : ""}</span><ArrowUpRight className="size-3 shrink-0" /></button>
        : <p className="text-[11px] text-muted-foreground">Not connected</p>}</div>
      <Button variant="ghost" size="icon-sm" disabled={current.loading || current.refreshing || status.loading} aria-label={tab === "mine" ? "Refresh my tasks" : "Refresh project tasks"} onClick={() => { void (configured ? current.refresh() : status.refresh()) }}>{current.refreshing ? <Spinner /> : <RefreshCw />}</Button>
    </header>
    {actionError && <p role="alert" className="border-b p-3 text-xs text-destructive">{actionError}</p>}
    {!status.data && !statusError ? <LoadingRows label="Checking ClickUp connection" /> : !configured ? <>{statusError && <p role="alert" className="px-4 pt-3 text-xs text-destructive">{statusError.error}</p>}<SetupMessage /></> : <>
      <div className="flex h-9 shrink-0 items-end border-b px-3"><TabsList variant="line" className="h-full gap-3 p-0" aria-label="ClickUp views">
        <TabsTrigger value="mine" className="h-full flex-none rounded-none px-0 text-xs">My tasks{mine.data?.tasks.length ? <span className={`font-mono text-[10px] tabular-nums ${overdue ? "text-destructive" : "text-muted-foreground"}`}>{overdue || mine.data.tasks.length}</span> : null}</TabsTrigger>
        <TabsTrigger value="project" disabled={!context.project} className="h-full flex-none rounded-none px-0 text-xs">This project{project.data?.tasks.filter((task) => !isFinished(task)).length ? <span className="font-mono text-[10px] text-muted-foreground">{project.data.tasks.filter((task) => !isFinished(task)).length}</span> : null}</TabsTrigger>
      </TabsList></div>
      <div className="flex min-h-0 flex-1 flex-col">
        <TabsContent value="mine" className="flex min-h-0 flex-col"><ResourceFrame state={mine} retry={() => { void mine.refresh() }}>{(data) => <TaskList tasks={data.tasks} viewer={data.viewer} composePrompt={composePrompt} openExternal={openExternal} emptyTitle="Nothing assigned to you" emptyDescription="Open tasks assigned to you anywhere in the workspace will show up here." truncated={data.truncated} />}</ResourceFrame></TabsContent>
        <TabsContent value="project" className="flex min-h-0 flex-col"><ResourceFrame state={project} retry={() => { void project.refresh() }}>{(data) => <>
          <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground"><button type="button" className="min-w-0 flex-1 truncate text-left hover:text-foreground" onClick={() => openExternal(data.list.url)}>{locationLabel(data.list.folderName, data.list.name)}</button></div>
          <TaskList tasks={data.tasks} viewer={data.viewer} composePrompt={composePrompt} openExternal={openExternal} emptyTitle="No tasks in this list" emptyDescription="Tasks added to the linked list will show up here." truncated={data.truncated} />
        </>}</ResourceFrame></TabsContent>
      </div>
    </>}
  </Tabs>
}
