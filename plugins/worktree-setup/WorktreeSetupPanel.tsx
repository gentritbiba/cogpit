import { useEffect, useId, useState } from "react"
import { Button } from "@cogpit/plugin-ui/button"
import { Input } from "@cogpit/plugin-ui/input"
import { WORKTREE_SETUP_DEFAULT_TIMEOUT_MS, worktreeSetupActive, type WorktreeSetupOperation, type WorktreeSetupRecipe, type WorktreeSetupSnapshot } from "@cogpit/plugin-integrations/worktreeSetup"

export interface WorktreeSetupApi {
  snapshot(signal: AbortSignal): Promise<WorktreeSetupSnapshot>
  scripts(signal: AbortSignal): Promise<{ name: string; command: string }[]>
  /** Asks Cogpit to show the exact command for the user's confirmation; resolves once its dialog is open. */
  propose(command: string, timeoutMs: number): Promise<void>
  act(operationId: string, action: "retry" | "cancel"): Promise<WorktreeSetupSnapshot>
}

const stageLabel: Record<WorktreeSetupOperation["stage"], string> = {
  initializing: "Initializing worktree", setup: "Running setup", failed: "Setup failed — first prompt is waiting", "agent-start": "Starting agent", ready: "Agent started", cancelled: "Cancelled — worktree retained", interrupted: "Startup interrupted — worktree retained",
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]|\x1b[()][AB012]/g
const stripAnsi = (text: string) => text.replace(ANSI, "").replace(/\[2K\[1G/g, "\n").replace(/\r/g, "")
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

function RecipeEditor({ recipe, api }: { recipe: WorktreeSetupRecipe | null; api: WorktreeSetupApi }) {
  const id = useId()
  const [command, setCommand] = useState(recipe?.command ?? "")
  const [minutes, setMinutes] = useState((recipe?.timeoutMs ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_MS) / 60_000)
  const [scripts, setScripts] = useState<{ name: string; command: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api.scripts(controller.signal).then(setScripts, () => {})
    return () => controller.abort()
  }, [api])
  const unchanged = command.trim() === (recipe?.command ?? "") && minutes * 60_000 === (recipe?.timeoutMs ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_MS)
  return (
    <form className="space-y-5" onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setStatus(null)
      void api.propose(command, Math.round(minutes * 60_000)).then(() => setStatus("Confirm the command in Cogpit's dialog to save it."), (error: unknown) => setStatus(message(error, "Unable to review recipe"))).finally(() => setBusy(false))
    }}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${id}-command`}>Project setup command</label>
        <textarea id={`${id}-command`} className="min-h-24 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" rows={3} value={command} placeholder="bun install" onChange={(event) => setCommand(event.target.value)} />
        <p className="text-xs text-muted-foreground">Runs before the first prompt in each new worktree. Clear to disable.</p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        {scripts.length > 0 && <label className="min-w-0 flex-1 space-y-2 text-sm font-medium">Use a project script
          <select className="mt-2 h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring" value="" onChange={(event) => setCommand(`bun run ${event.target.value}`)}>
            <option value="">Choose a script…</option>
            {scripts.map((script) => <option key={script.name} value={script.name}>{script.name}: {script.command}</option>)}
          </select>
        </label>}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-timeout`}>Timeout (min)</label>
          <Input id={`${id}-timeout`} className="h-9 w-24" type="number" min={1} max={60} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />
        </div>
      </div>
      <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">Cogpit shows the exact command and asks you to trust it and the project code it runs before saving.</p>
      {status && <p role="status" className="text-sm">{status}</p>}
      <div className="flex justify-end border-t pt-4">
        <Button type="submit" size="sm" disabled={busy || unchanged || !Number.isInteger(minutes) || minutes < 1 || minutes > 60}>{busy ? "Opening…" : command.trim() ? "Review and save" : "Disable setup"}</Button>
      </div>
    </form>
  )
}

function OperationRow({ operation, act }: { operation: WorktreeSetupOperation; act: (id: string, action: "retry" | "cancel") => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return <article aria-label={`Worktree ${operation.worktreeName}`} className="space-y-1 text-xs">
    <p role="status" className="font-medium">{operation.worktreeName} · {stageLabel[operation.stage]}</p>
    {operation.command && <p className="break-all font-mono">$ {operation.command} · attempt {operation.attempt}{operation.exitCode !== undefined ? ` · exit ${operation.exitCode ?? "unknown"}` : ""}</p>}
    {operation.error && <p role="alert" className="text-destructive">{operation.error}</p>}
    {operation.output && <details open={operation.stage === "failed"}><summary className="cursor-pointer">Setup output{operation.outputTruncated ? " (older output trimmed)" : ""}</summary><pre aria-label="Setup output" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{stripAnsi(operation.output)}</pre></details>}
    {worktreeSetupActive(operation.stage) && <div className="flex gap-2">
      {(operation.stage === "failed" ? ["retry", "cancel"] as const : ["cancel"] as const).map((action) => <Button key={action} size="xs" variant="outline" disabled={busy} onClick={() => {
        setBusy(true)
        void act(operation.id, action).finally(() => setBusy(false))
      }}>{action === "retry" ? "Retry setup" : "Cancel startup"}</Button>)}
    </div>}
  </article>
}

export function WorktreeSetupPanel({ api, active }: { api: WorktreeSetupApi; active: boolean }) {
  const [snapshot, setSnapshot] = useState<WorktreeSetupSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { const value = await api.snapshot(controller.signal); if (!controller.signal.aborted) { setSnapshot(value); setError(null) } }
      catch (failure) { if (!controller.signal.aborted) setError(message(failure, "Unable to load worktree setup")) }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, active])
  const act = async (id: string, action: "retry" | "cancel") => {
    setActionError(null)
    try { setSnapshot(await api.act(id, action)) } catch (failure) { setActionError(message(failure, "Unable to update startup")) }
  }
  const operations = snapshot?.operations.slice(0, 10) ?? []
  return (
    <main className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 text-left text-foreground">
      <header className="space-y-1">
        <h1 className="text-sm font-semibold">Worktree setup {snapshot?.recipe && <span className="text-xs font-normal text-muted-foreground">· enabled</span>}</h1>
        <p className="text-xs text-muted-foreground">Optional preparation for new worktrees, saved for this project on this machine.</p>
      </header>
      {snapshot ? <RecipeEditor key={snapshot.recipe?.revision ?? "none"} recipe={snapshot.recipe} api={api} /> : <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{error || "Loading setup configuration…"}</p>}
      {operations.length > 0 && <section aria-label="Recent worktree startups" className="space-y-2 rounded-lg border p-3">
        {(actionError || error) && <p role="alert" className="text-xs text-destructive">{actionError || error}</p>}
        {operations.map((operation) => <OperationRow key={operation.id} operation={operation} act={act} />)}
      </section>}
    </main>
  )
}
