import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
    <form className="space-y-2" onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setMessage(null)
      void configure(command, trusted, minutes * 60_000).then(() => setMessage("Setup recipe saved"), (error: unknown) => setMessage(error instanceof Error ? error.message : "Unable to save recipe")).finally(() => setBusy(false))
    }}>
      <p className="text-xs text-muted-foreground">Saved for your account, this host and this Git project. Runs in each new worktree before its first agent prompt.</p>
      <label className="block text-xs" htmlFor={`${id}-command`}>Project setup command</label>
      <textarea id={`${id}-command`} className="w-full rounded border bg-background p-2 font-mono text-xs" rows={2} value={command} placeholder="bun install" onChange={(event) => { setCommand(event.target.value); setTrusted(false) }} />
      {rootScripts.length > 0 && <label className="block text-xs">Use a project script
        <select className="ml-2 max-w-full rounded border bg-background p-1" value="" onChange={(event) => { setCommand(`bun run ${event.target.value}`); setTrusted(false) }}>
          <option value="">Choose a script…</option>
          {rootScripts.map((script) => <option key={script.name} value={script.name}>{script.name}: {script.command}</option>)}
        </select>
      </label>}
      <label className="flex items-center gap-2 text-xs" htmlFor={`${id}-timeout`}>Timeout (minutes)
        <Input id={`${id}-timeout`} className="h-7 w-20" type="number" min={1} max={60} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />
      </label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />I trust this command and the project code it runs in new worktrees.</label>
      <p className="text-xs text-muted-foreground">Repository scripts are suggestions. Saving a trusted command enables automatic setup. Clear the command to disable it.</p>
      <Button type="submit" size="sm" disabled={busy || (!!command.trim() && !trusted)}>Save setup recipe</Button>
      {message && <p role="status" className="text-xs">{message}</p>}
    </form>
  )
}

export function WorktreeSetupPanel({ projectCwd, dirName, progressOnly = false, compact = false }: { projectCwd?: string | null; dirName?: string | null; progressOnly?: boolean; compact?: boolean }) {
  const hostFiles = useCapability("hostFiles")
  const terminal = useCapability("terminal")
  const allowed = hostFiles && terminal
  const { snapshot, error, configure, act } = useWorktreeSetup({ cwd: projectCwd, dirName }, allowed)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (!allowed || (!projectCwd && !dirName)) return null
  const operations = snapshot?.operations ?? []
  const visible = progressOnly ? operations.filter((operation) => worktreeSetupActive(operation.stage) || operation.stage === "cancelled" || operation.stage === "interrupted").slice(0, 3) : operations.slice(0, 10)
  if (progressOnly && visible.length === 0) return null
  return (
    <section aria-label="Worktree setup" className={`${compact ? "max-h-40" : "max-h-80"} shrink-0 space-y-2 overflow-y-auto rounded border p-3 text-left`}>
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
      {!progressOnly && <details>
        <summary className="cursor-pointer text-xs font-medium">Worktree setup recipe {snapshot?.recipe ? "· enabled" : "· not configured"}</summary>
        <div className="pt-3">{snapshot ? <RecipeEditor key={snapshot.projectCwd} recipe={snapshot.recipe} projectCwd={snapshot.projectCwd} configure={configure} /> : <p role="status" className="text-xs">{error || "Loading setup configuration…"}</p>}</div>
      </details>}
    </section>
  )
}
