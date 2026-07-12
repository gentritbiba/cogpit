import { useCallback, useEffect, useState } from "react"
import { Check, Flag, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react"
import { authFetch } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"

interface CodexGoal {
  threadId: string
  objective: string
  status: string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

interface GoalResponse {
  goal: CodexGoal | null
}

function statusLabel(status: string): string {
  if (status === "usageLimited") return "Usage limited"
  if (status === "budgetLimited") return "Budget limited"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function statusColor(status: string): string {
  if (status === "complete") return "text-emerald-400"
  if (status === "blocked" || status.endsWith("Limited")) return "text-amber-400"
  if (status === "paused") return "text-blue-400"
  return "text-violet-400"
}

export function CodexGoalBar({ threadId }: { threadId: string }) {
  const [goal, setGoal] = useState<CodexGoal | null>(null)
  const [available, setAvailable] = useState(true)
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState("")
  const [tokenBudget, setTokenBudget] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await authFetch(`/api/codex/goals/${encodeURIComponent(threadId)}`, { signal })
      if (res.status === 404 || res.status === 501) {
        setAvailable(false)
        return
      }
      if (!res.ok) return
      const data = await res.json() as GoalResponse
      setGoal(data.goal)
      setAvailable(true)
    } catch (fetchError) {
      if (!(fetchError instanceof Error && fetchError.name === "AbortError")) {
        setError("Could not refresh this goal")
      }
    }
  }, [threadId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const interval = setInterval(() => void refresh(), 10_000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [refresh])

  const beginEditing = () => {
    setObjective(goal?.objective ?? "")
    setTokenBudget(goal?.tokenBudget?.toString() ?? "")
    setError(null)
    setEditing(true)
  }

  const saveGoal = async () => {
    const trimmed = objective.trim()
    if (!trimmed) return
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null
    if (parsedBudget !== null && (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0)) {
      setError("Token budget must be a positive whole number")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await authFetch(`/api/codex/goals/${encodeURIComponent(threadId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: trimmed,
          status: goal?.status === "complete" ? "active" : goal?.status ?? "active",
          tokenBudget: parsedBudget,
        }),
      })
      const data = await res.json() as GoalResponse & { error?: string }
      if (!res.ok) throw new Error(data.error || "Could not save goal")
      setGoal(data.goal)
      setEditing(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save goal")
    } finally {
      setSaving(false)
    }
  }

  const updateStatus = async (status: "active" | "paused" | "complete") => {
    if (!goal) return
    setSaving(true)
    try {
      const res = await authFetch(`/api/codex/goals/${encodeURIComponent(threadId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (res.ok) setGoal(((await res.json()) as GoalResponse).goal)
    } finally {
      setSaving(false)
    }
  }

  const clearGoal = async () => {
    setSaving(true)
    try {
      const res = await authFetch(`/api/codex/goals/${encodeURIComponent(threadId)}`, { method: "DELETE" })
      if (res.ok) {
        setGoal(null)
        setEditing(false)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!available) return null

  if (editing) {
    return (
      <div className="mx-3 mb-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-violet-300">
          <Flag className="size-3" />
          {goal ? "Edit long-running goal" : "Set a long-running goal"}
        </div>
        <label className="sr-only" htmlFor="codex-goal-objective">Goal objective</label>
        <textarea
          id="codex-goal-objective"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="What should Codex keep working toward?"
          rows={2}
          className="w-full resize-none rounded-md border border-border/60 bg-elevation-2 px-2.5 py-2 text-xs text-foreground outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20"
          autoFocus
        />
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="codex-goal-budget" className="text-[10px] text-muted-foreground">Token budget</label>
          <input
            id="codex-goal-budget"
            type="number"
            min={1}
            step={1}
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.target.value)}
            placeholder="Optional"
            className="w-28 rounded border border-border/60 bg-elevation-2 px-2 py-1 text-[10px] text-foreground outline-none focus:border-violet-500/50"
          />
          <span className="flex-1" />
          <button type="button" onClick={() => setEditing(false)} className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground" aria-label="Cancel goal editing">
            <X className="size-3.5" />
          </button>
          <button type="button" onClick={() => void saveGoal()} disabled={saving || !objective.trim()} className="flex items-center gap-1 rounded bg-violet-500/20 px-2 py-1 text-[10px] font-medium text-violet-200 hover:bg-violet-500/30 disabled:opacity-40">
            <Check className="size-3" /> Save goal
          </button>
        </div>
        {error && <div role="alert" className="mt-1.5 text-[10px] text-red-400">{error}</div>}
      </div>
    )
  }

  if (!goal) {
    return (
      <div className="mx-3 mb-1 flex justify-end">
        <button type="button" onClick={beginEditing} className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-white/5 hover:text-violet-300">
          <Plus className="size-3" /> Set goal
        </button>
      </div>
    )
  }

  const percent = goal.tokenBudget
    ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
    : null

  return (
    <div className="mx-3 mb-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 size-3 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground" title={goal.objective}>{goal.objective}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[9px] text-muted-foreground">
            <span className={cn("font-medium", statusColor(goal.status))}>{statusLabel(goal.status)}</span>
            <span>{formatTokenCount(goal.tokensUsed)} tokens</span>
            {goal.tokenBudget && <span>of {formatTokenCount(goal.tokenBudget)}</span>}
            <span>{Math.max(0, Math.round(goal.timeUsedSeconds / 60))}m</span>
          </div>
          {percent !== null && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-elevation-3" aria-label={`${percent.toFixed(0)}% of goal token budget used`}>
              <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {goal.status === "paused" ? (
            <button type="button" onClick={() => void updateStatus("active")} disabled={saving} className="rounded p-1 text-blue-400 hover:bg-blue-500/10" aria-label="Resume goal"><Play className="size-3" /></button>
          ) : goal.status !== "complete" ? (
            <button type="button" onClick={() => void updateStatus("paused")} disabled={saving} className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-blue-400" aria-label="Pause goal"><Pause className="size-3" /></button>
          ) : null}
          {goal.status !== "complete" && (
            <button type="button" onClick={() => void updateStatus("complete")} disabled={saving} className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-emerald-400" aria-label="Mark goal complete"><Check className="size-3" /></button>
          )}
          <button type="button" onClick={beginEditing} className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground" aria-label="Edit goal"><Pencil className="size-3" /></button>
          <button type="button" onClick={() => void clearGoal()} disabled={saving} className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400" aria-label="Clear goal"><Trash2 className="size-3" /></button>
        </div>
      </div>
    </div>
  )
}
