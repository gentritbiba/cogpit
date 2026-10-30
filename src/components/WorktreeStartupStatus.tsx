import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useCapability } from "@/hooks/useCapability"
import { authFetch } from "@/lib/auth"
import type { ActiveWorktreeStartup } from "../../shared/contracts/sessionStartup"

const stageLabel = (startup: ActiveWorktreeStartup) => startup.stage === "extension" && startup.extension
  ? `Waiting for ${startup.extension.name} — open it from the sidebar for output, retry or cancel`
  : startup.stage === "agent-start" ? "Starting agent" : "Initializing worktree"

/** Shows worktree startups that are holding a first prompt, while they run. Nothing renders once they finish. */
export function WorktreeStartupStatus({ projectCwd, compact = false }: { projectCwd: string | null | undefined; compact?: boolean }) {
  const hostFiles = useCapability("hostFiles")
  const terminal = useCapability("terminal")
  const allowed = hostFiles && terminal
  const [state, setState] = useState<{ cwd: string; startups: ActiveWorktreeStartup[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!allowed || !projectCwd) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await authFetch(`/api/session-startups?cwd=${encodeURIComponent(projectCwd)}`, { signal: controller.signal })
        const value = await response.json() as { startups?: ActiveWorktreeStartup[] }
        if (!controller.signal.aborted && response.ok) setState({ cwd: projectCwd, startups: value.startups ?? [] })
      } catch { /* The next poll retries; a stopped server leaves nothing to show. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [allowed, projectCwd])
  const startups = state && state.cwd === projectCwd ? state.startups : []
  if (!allowed || startups.length === 0) return null
  return (
    <section aria-label="Worktree startup" className={`${compact ? "max-h-40" : "max-h-60"} min-w-0 shrink-0 space-y-2 overflow-y-auto rounded-lg border p-3 text-left text-xs`}>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {startups.map((startup) => <article key={startup.id} aria-label={`Worktree ${startup.worktreeName}`} className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="min-w-0 font-medium">{startup.worktreeName} · {stageLabel(startup)}</p>
        <Button size="xs" variant="outline" onClick={() => {
          setError(null)
          void authFetch("/api/session-startups/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: startup.id }) })
            .then(async (response) => { if (!response.ok) throw new Error((await response.json()).error || "Unable to cancel startup") })
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Unable to cancel startup"))
        }}>Cancel startup</Button>
      </article>)}
    </section>
  )
}
