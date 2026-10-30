import { useId, useState } from "react"
import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useCapability } from "@/hooks/useCapability"
import { useScriptDiscovery } from "@/hooks/useScriptDiscovery"
import { useWorktreeSetup } from "@/hooks/useWorktreeSetup"
import { stripAnsi } from "@/lib/ansi"
import { WORKTREE_SETUP_DEFAULT_TIMEOUT_MS, worktreeSetupActive, type WorktreeSetupOperation, type WorktreeSetupRecipe } from "../../shared/contracts/worktreeSetup"

const stageLabel: Record<WorktreeSetupOperation["stage"], string> = {
  initializing: "Initializing worktree", setup: "Running setup", failed: "Setup failed — first prompt is waiting", "agent-start": "Starting agent", ready: "Agent started", cancelled: "Cancelled — worktree retained", interrupted: "Startup interrupted — worktree retained",
}

function RecipeEditor({ recipe, projectCwd, configure }: { recipe: WorktreeSetupRecipe | null; projectCwd: string; configure: (command: string, trusted: boolean, timeoutMs: number) => Promise<void> }) {
  const id = useId()
  const [command, setCommand] = useState(recipe?.command ?? "")
  const [trusted, setTrusted] = useState(false)
  const [minutes, setMinutes] = useState((recipe?.timeoutMs ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_MS) / 60_000)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const { scripts } = useScriptDiscovery(projectCwd)
  const rootScripts = scripts.filter((script) => script.dirLabel === "root/" && /^[\w:@/.-]+$/.test(script.name))
  return (
    <form className="space-y-5" onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setMessage(null)
      void configure(command, trusted, minutes * 60_000).then(() => setMessage("Setup recipe saved"), (error: unknown) => setMessage(error instanceof Error ? error.message : "Unable to save recipe")).finally(() => setBusy(false))
    }}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${id}-command`}>Project setup command</label>
        <Textarea id={`${id}-command`} className="min-h-24 resize-y font-mono text-xs md:text-xs" rows={3} value={command} placeholder="bun install" onChange={(event) => { setCommand(event.target.value); setTrusted(false) }} />
        <p className="text-xs text-muted-foreground">Runs before the first prompt in each new worktree. Clear to disable.</p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        {rootScripts.length > 0 && <label className="min-w-0 flex-1 space-y-2 text-sm font-medium">Use a project script
          <select className="mt-2 h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" value="" onChange={(event) => { setCommand(`bun run ${event.target.value}`); setTrusted(false) }}>
            <option value="">Choose a script…</option>
            {rootScripts.map((script) => <option key={script.name} value={script.name}>{script.name}: {script.command}</option>)}
          </select>
        </label>}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-timeout`}>Timeout (min)</label>
          <Input id={`${id}-timeout`} className="h-9 w-24" type="number" min={1} max={60} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />
        </div>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3">
        <label className="flex items-start gap-3 text-sm leading-relaxed" htmlFor={`${id}-trust`}>
          <Checkbox id={`${id}-trust`} className="mt-0.5 shrink-0" checked={trusted} onCheckedChange={setTrusted} />
          I trust this command and the project code it runs in new worktrees.
        </label>
      </div>
      {message && <p role="status" className="text-sm">{message}</p>}
      <div className="flex justify-end border-t pt-4">
        <Button type="submit" size="sm" disabled={busy || (!!command.trim() && !trusted)}>{busy ? "Saving…" : "Save setup recipe"}</Button>
      </div>
    </form>
  )
}

export function WorktreeSetupPanel({ projectCwd, dirName, progressOnly = false, compact = false }: { projectCwd?: string | null; dirName?: string | null; progressOnly?: boolean; compact?: boolean }) {
  const hostFiles = useCapability("hostFiles")
  const terminal = useCapability("terminal")
  const allowed = hostFiles && terminal
  const { snapshot, error, configure, act } = useWorktreeSetup({ cwd: projectCwd, dirName }, allowed)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (!allowed || (!projectCwd && !dirName)) return null
  const operations = snapshot?.operations ?? []
  const visible = progressOnly ? operations.filter((operation) => worktreeSetupActive(operation.stage) || operation.stage === "cancelled" || operation.stage === "interrupted").slice(0, 3) : operations.slice(0, 10)
  if (progressOnly && visible.length === 0) return null
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-2 text-left">
      {visible.length > 0 && <section aria-label="Worktree setup" className={`${compact ? "max-h-40" : "max-h-80"} space-y-2 overflow-y-auto rounded-lg border p-3`}>
      {(actionError || (error && visible.length > 0)) && <p role="alert" className="text-xs text-destructive">{actionError || error}</p>}
      {visible.map((operation) => <article key={operation.id} aria-label={`Worktree ${operation.worktreeName}`} className="space-y-1 text-xs">
        <p role="status" className="font-medium">{operation.worktreeName} · {stageLabel[operation.stage]}</p>
        {operation.cwd && <p className="break-all font-mono text-muted-foreground">{operation.cwd}</p>}
        {operation.command && <p className="break-all font-mono">$ {operation.command} · attempt {operation.attempt}{operation.exitCode !== undefined ? ` · exit ${operation.exitCode ?? "unknown"}` : ""}</p>}
        {operation.error && <p role="alert" className="text-destructive">{operation.error}</p>}
        {operation.output && <details open={operation.stage === "failed"}><summary className="cursor-pointer">Setup output{operation.outputTruncated ? " (older output trimmed)" : ""}</summary><pre aria-label="Setup output" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{stripAnsi(operation.output)}</pre></details>}
        {worktreeSetupActive(operation.stage) && <div className="flex gap-2">
          {(operation.stage === "failed" ? ["retry", "cancel"] as const : ["cancel"] as const).map((action) => <Button key={action} size="xs" variant="outline" disabled={busy === operation.id} onClick={() => {
            setBusy(operation.id); setActionError(null)
            void act(operation.id, action).catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Unable to update startup")).finally(() => setBusy(null))
          }}>{action === "retry" ? "Retry setup" : "Cancel startup"}</Button>)}
        </div>}
      </article>)}
      </section>}
      {!progressOnly && <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogTrigger render={<Button variant="ghost" size="xs" className="self-start text-muted-foreground" />}>
          <Settings2 data-icon="inline-start" />
          Setup recipe
          {snapshot?.recipe && <span className="text-[10px] text-muted-foreground">· enabled</span>}
        </DialogTrigger>
        <DialogContent className="max-h-[85dvh] overflow-y-auto text-left">
          <DialogHeader>
            <DialogTitle>Worktree setup</DialogTitle>
            <DialogDescription>Optional preparation for new worktrees, saved for this project on this machine.</DialogDescription>
          </DialogHeader>
          {settingsOpen && (snapshot ? <RecipeEditor key={snapshot.projectCwd} recipe={snapshot.recipe} projectCwd={snapshot.projectCwd} configure={configure} /> : <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{error || "Loading setup configuration…"}</p>)}
        </DialogContent>
      </Dialog>}
    </div>
  )
}
