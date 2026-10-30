import { useEffect, useId, useState } from "react"
import { CalendarClock, Pause, Play, Plus, Trash2, Webhook, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAutomations, type RunAction } from "@/hooks/useAutomations"
import { useCapability } from "@/hooks/useCapability"
import { useModelOptions } from "@/hooks/useModelOptions"
import { authFetch } from "@/lib/auth"
import { AGENT_KINDS, DEFAULT_AGENT_KIND, descriptorFor, projectDirNameFor, type AgentKind } from "@/lib/agents"
import { copyToClipboard } from "@/lib/utils"
import type { WorkspacePanelProps } from "@/plugin-api"
import { WEEKDAYS, type AutomationDefinition, type AutomationRun, type AutomationSchedule, type AutomationTask, type Weekday } from "../../shared/contracts/automations"

/**
 * Scheduled and webhook-triggered tasks (item 8): create, edit, pause,
 * resume, run now, delete, and each task's run history with the controls a
 * run's state allows.
 */

const INPUT = "w-full rounded border bg-background px-2 py-1 text-xs"
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function scheduleText(schedule: AutomationSchedule | null): string {
  if (!schedule) return "No schedule"
  if (schedule.kind === "interval") return `Every ${schedule.everyMinutes} min`
  const days = schedule.days.length === 7 ? "every day" : schedule.days.join(", ")
  return `${schedule.time} ${days} (${schedule.timeZone})`
}

function when(instant: number | null | undefined): string {
  return instant ? new Date(instant).toLocaleString() : "—"
}

const STATE_TEXT: Record<AutomationRun["state"], string> = {
  scheduled: "Waiting", admitting: "Starting", creating: "Starting session", admitted: "Delivering", held: "Held", unknown: "Outcome unknown",
  completed: "Started", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped",
}

interface Draft {
  name: string
  prompt: string
  cwd: string
  agent: AgentKind
  instanceId: string
  model: string
  workspace: AutomationDefinition["workspace"]
  scheduleKind: "none" | "interval" | "daily"
  everyMinutes: number
  time: string
  days: Weekday[]
  timeZone: string
  webhook: boolean
  scheme: "cogpit" | "github"
  coalesceSeconds: number
  missed: AutomationDefinition["missed"]
  overlap: AutomationDefinition["overlap"]
  paused: boolean
}

function draftOf(task: AutomationTask | null, cwd: string | null): Draft {
  const schedule = task?.schedule
  return {
    name: task?.name ?? "",
    prompt: task?.prompt ?? "",
    cwd: task?.project.cwd ?? cwd ?? "",
    agent: task?.provider.agent ?? DEFAULT_AGENT_KIND,
    instanceId: task?.provider.instanceId ?? "default",
    model: task?.provider.model ?? "",
    workspace: task?.workspace ?? "project",
    scheduleKind: schedule ? schedule.kind : task ? "none" : "daily",
    everyMinutes: schedule?.kind === "interval" ? schedule.everyMinutes : 60,
    time: schedule?.kind === "daily" ? schedule.time : "09:00",
    days: schedule?.kind === "daily" ? schedule.days : ["mon", "tue", "wed", "thu", "fri"],
    timeZone: schedule?.kind === "daily" ? schedule.timeZone : LOCAL_ZONE,
    webhook: task?.webhook?.enabled ?? false,
    scheme: task?.webhook?.scheme ?? "cogpit",
    coalesceSeconds: task?.webhook?.coalesceSeconds ?? 30,
    missed: task?.missed ?? "skip",
    overlap: task?.overlap ?? "skip",
    paused: task?.state === "paused",
  }
}

function definitionOf(draft: Draft): AutomationDefinition {
  const cwd = draft.cwd.trim()
  return {
    name: draft.name,
    prompt: draft.prompt,
    project: { dirName: projectDirNameFor(draft.agent, cwd), cwd },
    provider: { agent: draft.agent, instanceId: draft.instanceId, ...(draft.model.trim() ? { model: draft.model.trim() } : {}) },
    workspace: draft.workspace,
    schedule: draft.scheduleKind === "none" ? null : draft.scheduleKind === "interval"
      ? { kind: "interval", everyMinutes: draft.everyMinutes }
      : { kind: "daily", time: draft.time, days: draft.days, timeZone: draft.timeZone },
    webhook: draft.webhook ? { enabled: true, scheme: draft.scheme, coalesceSeconds: draft.coalesceSeconds } : null,
    missed: draft.missed,
    overlap: draft.overlap,
  }
}

function TaskForm({ task, cwd, onSave, onCancel }: {
  task: AutomationTask | null
  cwd: string | null
  onSave: (definition: AutomationDefinition, state: "active" | "paused") => Promise<void>
  onCancel: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(() => draftOf(task, cwd))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [instances, setInstances] = useState<Array<{ id: string; agent: AgentKind; label: string; retired?: boolean }>>([])
  const models = useModelOptions(draft.agent, draft.instanceId)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  useEffect(() => {
    void authFetch("/api/provider-instances").then((response) => response.ok ? response.json() : { instances: [] }).then((body: { instances?: typeof instances }) => setInstances(body.instances ?? []), () => {})
  }, [])
  const field = (name: string) => `${id}-${name}`

  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3 text-xs"
      aria-label={task ? `Edit ${task.name}` : "New task"}
      onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        setError(null)
        void onSave(definitionOf(draft), draft.paused ? "paused" : "active").catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not save")).finally(() => setSaving(false))
      }}
    >
      <label htmlFor={field("name")}>Name</label>
      <input id={field("name")} className={INPUT} value={draft.name} required maxLength={120} onChange={(event) => set("name", event.target.value)} />
      <label htmlFor={field("prompt")}>What the session should do</label>
      <textarea id={field("prompt")} className={INPUT} rows={4} value={draft.prompt} required onChange={(event) => set("prompt", event.target.value)} />
      <label htmlFor={field("cwd")}>Project folder</label>
      <input id={field("cwd")} className={`${INPUT} font-mono`} value={draft.cwd} required placeholder="/path/to/project" onChange={(event) => set("cwd", event.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">Provider
          <select className={INPUT} value={draft.agent} onChange={(event) => setDraft((current) => ({ ...current, agent: event.target.value as AgentKind, instanceId: "default", model: "" }))}>
            {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{descriptorFor(kind).displayName}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Account
          <select className={INPUT} value={draft.instanceId} onChange={(event) => set("instanceId", event.target.value)}>
            <option value="default">Default</option>
            {instances.filter((instance) => instance.agent === draft.agent && !instance.retired).map((instance) => <option key={instance.id} value={instance.id}>{instance.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Model
          <select className={INPUT} value={draft.model} onChange={(event) => set("model", event.target.value)}>
            <option value="">Provider default</option>
            {models.filter((model) => model.value).map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Workspace
          <select className={INPUT} value={draft.workspace} onChange={(event) => set("workspace", event.target.value as Draft["workspace"])}>
            <option value="project">Project folder</option>
            <option value="worktree">New worktree per run</option>
          </select>
        </label>
      </div>
      <fieldset className="flex flex-col gap-2 rounded border p-2">
        <legend className="px-1">Schedule</legend>
        <select aria-label="Schedule kind" className={INPUT} value={draft.scheduleKind} onChange={(event) => set("scheduleKind", event.target.value as Draft["scheduleKind"])}>
          <option value="none">None (webhook or manual only)</option>
          <option value="interval">Every few minutes</option>
          <option value="daily">At a time of day</option>
        </select>
        {draft.scheduleKind === "interval" && (
          <label className="flex items-center gap-2">Every <input aria-label="Minutes between runs" type="number" min={5} className={`${INPUT} w-20`} value={draft.everyMinutes} onChange={(event) => set("everyMinutes", Number(event.target.value))} /> minutes</label>
        )}
        {draft.scheduleKind === "daily" && (
          <>
            <label className="flex items-center gap-2">At <input aria-label="Time of day" type="time" className={`${INPUT} w-28`} value={draft.time} onChange={(event) => set("time", event.target.value)} />
              in <input aria-label="Time zone" className={`${INPUT} w-44`} value={draft.timeZone} onChange={(event) => set("timeZone", event.target.value)} /></label>
            <div role="group" aria-label="Weekdays" className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex items-center gap-1">
                  <input type="checkbox" checked={draft.days.includes(day)} onChange={(event) => set("days", event.target.checked ? WEEKDAYS.filter((d) => d === day || draft.days.includes(d)) : draft.days.filter((d) => d !== day))} />{day}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="flex flex-col gap-1">If runs were missed while Cogpit was off
          <select className={INPUT} value={draft.missed} onChange={(event) => set("missed", event.target.value as Draft["missed"])}>
            <option value="skip">Skip them</option>
            <option value="run-once">Run once when back</option>
          </select>
        </label>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded border p-2">
        <legend className="px-1">Webhook</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.webhook} onChange={(event) => set("webhook", event.target.checked)} /> Run when a signed delivery arrives</label>
        {draft.webhook && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">Signature
              <select className={INPUT} value={draft.scheme} onChange={(event) => set("scheme", event.target.value as Draft["scheme"])}>
                <option value="cogpit">Cogpit (timestamped)</option>
                <option value="github">GitHub (X-Hub-Signature-256)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">Group a burst for (seconds)
              <input type="number" min={0} max={600} className={INPUT} value={draft.coalesceSeconds} onChange={(event) => set("coalesceSeconds", Number(event.target.value))} />
            </label>
          </div>
        )}
      </fieldset>
      <label className="flex flex-col gap-1">While the previous run still works
        <select className={INPUT} value={draft.overlap} onChange={(event) => set("overlap", event.target.value as Draft["overlap"])}>
          <option value="skip">Skip the new run</option>
          <option value="allow">Start it anyway</option>
        </select>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.paused} onChange={(event) => set("paused", event.target.checked)} /> Save paused</label>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : task ? "Save changes" : "Create task"}</Button>
      </div>
    </form>
  )
}

function Runs({ task, automations, openSession }: { task: AutomationTask; automations: ReturnType<typeof useAutomations>; openSession?: (dirName: string, fileName: string) => void }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => { void automations.runs(task.id).then(setRuns, (failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not load runs")) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [task.id, task.updatedAt])
  const act = (run: AutomationRun, action: RunAction) => { void automations.actOnRun(task.id, run.id, action).then(load, (failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not update the run")) }
  if (error) return <p role="alert" className="text-xs text-destructive">{error}</p>
  if (!runs) return <p role="status" className="text-xs text-muted-foreground">Loading runs…</p>
  if (runs.length === 0) return <p className="text-xs text-muted-foreground">No runs yet.</p>
  return (
    <ol aria-label={`Runs of ${task.name}`} className="flex flex-col gap-1">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs">
          <span className="font-medium">{STATE_TEXT[run.state]}</span>
          <span className="text-muted-foreground">{run.trigger}{run.deliveries > 1 ? ` · ${run.deliveries} deliveries` : ""} · {when(run.dueAt)}</span>
          {run.session && <span className="text-muted-foreground">{run.session.working ? "session working" : "session idle"}</span>}
          {run.reason && <span className="basis-full text-muted-foreground">{run.reason}</span>}
          <span className="ml-auto flex gap-1">
            {run.session?.dirName && run.session.fileName && openSession && <Button size="xs" variant="ghost" onClick={() => openSession(run.session!.dirName!, run.session!.fileName!)}>Open session</Button>}
            {(run.state === "scheduled" || run.state === "held") && <Button size="xs" variant="ghost" onClick={() => act(run, "cancel")}>Cancel</Button>}
            {run.state === "held" && run.hold === "reauthorize" && <Button size="xs" variant="ghost" onClick={() => act(run, "reauthorize")}>Reauthorize</Button>}
            {run.state === "unknown" && <>
              <Button size="xs" variant="ghost" onClick={() => act(run, "mark-started")}>It started</Button>
              <Button size="xs" variant="ghost" onClick={() => act(run, "mark-not-started")}>It did not start</Button>
            </>}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function AutomationsPanel(props: WorkspacePanelProps) {
  const hostFiles = useCapability("hostFiles")
  const terminal = useCapability("terminal")
  if (!hostFiles || !terminal) return <p role="status" className="p-3 text-xs text-muted-foreground">Scheduled tasks need host-file and terminal access on this server.</p>
  return <Automations {...props} />
}

function Automations({ context, active }: WorkspacePanelProps) {
  const automations = useAutomations(active)
  const [editing, setEditing] = useState<AutomationTask | "new" | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ taskId: string; value: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const act = (promise: Promise<unknown>) => { void promise.catch((failure: unknown) => setNotice(failure instanceof Error ? failure.message : "The request failed")) }

  return (
    <section aria-label="Automations" className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Scheduled and webhook tasks</h2>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus data-icon="inline-start" />New task</Button>
      </div>
      {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
      {automations.error && <p role="alert" className="text-xs text-destructive">{automations.error}</p>}
      {editing && (
        <TaskForm
          task={editing === "new" ? null : editing}
          cwd={context.projectPath}
          onCancel={() => setEditing(null)}
          onSave={async (definition, state) => {
            const saved = await automations.save(definition, state, editing === "new" ? undefined : editing)
            if (saved.webhookSecret) setSecret({ taskId: saved.task.id, value: saved.webhookSecret })
            setEditing(null)
          }}
        />
      )}
      {secret && (
        <div role="status" className="flex flex-col gap-1 rounded-md border border-warning/40 p-2 text-xs">
          <p>Webhook secret — shown only now. Store it with the sender:</p>
          <code className="break-all font-mono">{secret.value}</code>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" onClick={() => void copyToClipboard(secret.value)}>Copy secret</Button>
            <Button size="xs" variant="ghost" onClick={() => setSecret(null)}>Done</Button>
          </div>
        </div>
      )}
      {automations.tasks?.length === 0 && !editing && <p className="text-xs text-muted-foreground">No tasks yet. A task starts a new session on a schedule, when a signed webhook arrives, or when you run it.</p>}
      <ul aria-label="Tasks" className="flex flex-col gap-2">
        {automations.tasks?.map((task) => (
          <li key={task.id} className="flex flex-col gap-2 rounded-md border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{task.name}</span>
              <span className="rounded bg-muted px-1.5">{task.state === "paused" ? "Paused" : "Active"}</span>
              {task.authority?.revoked && <span className="text-destructive">Authorization revoked</span>}
              {task.authority?.source === "none" && <span className="text-warning">Runs wait for you to reauthorize them</span>}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              <span><CalendarClock className="mr-1 inline size-3" aria-hidden />{scheduleText(task.schedule)}</span>
              <span>Next: {when(task.nextRunAt)}</span>
              <span className="font-mono">{task.project.cwd}</span>
              <span>{descriptorFor(task.provider.agent).displayName}{task.provider.model ? ` · ${task.provider.model}` : ""} · {task.workspace === "worktree" ? "new worktree" : "project folder"}</span>
            </div>
            {task.webhook?.enabled && (
              <div className="flex flex-col gap-1 text-muted-foreground">
                <span><Webhook className="mr-1 inline size-3" aria-hidden />{task.webhookUrl ? <code className="break-all">{task.webhookUrl}</code> : "Webhook ingress is not available on this server's sign-in"}</span>
                {task.webhookReachability === "local-only" && <span>Reachable only where this machine is; set COGPIT_PUBLIC_URL when a tunnel or proxy exposes it.</span>}
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              <Button size="xs" variant="outline" onClick={() => act(automations.act(task.id, "run"))}><Zap data-icon="inline-start" />Run now</Button>
              {task.state === "active"
                ? <Button size="xs" variant="ghost" onClick={() => act(automations.act(task.id, "pause"))}><Pause data-icon="inline-start" />Pause</Button>
                : <Button size="xs" variant="ghost" onClick={() => act(automations.act(task.id, "resume"))}><Play data-icon="inline-start" />Resume</Button>}
              <Button size="xs" variant="ghost" onClick={() => setEditing(task)}>Edit</Button>
              {task.webhook?.enabled && <Button size="xs" variant="ghost" onClick={() => act(automations.rotate(task.id).then((rotated) => setSecret({ taskId: task.id, value: rotated.webhookSecret })))}>Rotate secret</Button>}
              <Button size="xs" variant="ghost" aria-expanded={expanded === task.id} onClick={() => setExpanded(expanded === task.id ? null : task.id)}>History</Button>
              <Button size="xs" variant="ghost" aria-label={`Delete ${task.name}`} onClick={() => { if (window.confirm(`Delete ${task.name}? Waiting runs are cancelled.`)) act(automations.remove(task.id)) }}><Trash2 data-icon="inline-start" /></Button>
            </div>
            {expanded === task.id && <Runs task={task} automations={automations} openSession={context.openSession} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
