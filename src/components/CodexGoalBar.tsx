import { useCallback, useEffect, useState } from "react"
import { Check, Flag, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react"
import { authFetch } from "@/lib/auth"
import { formatTokenCount } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"

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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "complete") return "secondary"
  if (status === "blocked" || status.endsWith("Limited")) return "destructive"
  if (status === "paused") return "outline"
  return "default"
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
      <form
        className="mb-2 border-y border-border bg-muted/20 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void saveGoal()
        }}
      >
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
          <Flag className="size-4" data-icon="inline-start" />
          {goal ? "Edit long-running goal" : "Set a long-running goal"}
        </div>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="codex-goal-objective">Goal objective</FieldLabel>
            <Textarea
              id="codex-goal-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="What should Codex keep working toward?"
              rows={2}
              autoFocus
            />
          </Field>
          <Field orientation="horizontal" data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="codex-goal-budget">Token budget</FieldLabel>
            <Input
              id="codex-goal-budget"
              type="number"
              min={1}
              step={1}
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
              placeholder="Optional"
              className="ml-auto w-32"
              aria-invalid={Boolean(error)}
            />
          </Field>
        </FieldGroup>
        <FieldError className="mt-2">{error}</FieldError>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            <X data-icon="inline-start" />
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !objective.trim()}>
            <Check data-icon="inline-start" />
            Save goal
          </Button>
        </div>
      </form>
    )
  }

  if (!goal) {
    return (
      <div className="mx-3 mb-1 flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={beginEditing}>
          <Plus data-icon="inline-start" />
          Set goal
        </Button>
      </div>
    )
  }

  const percent = goal.tokenBudget
    ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
    : null

  return (
    <section className="mb-2 border-y border-border bg-muted/20 px-4 py-2.5" aria-label="Codex goal">
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 size-4 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={goal.objective}>{goal.objective}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={statusVariant(goal.status)}>{statusLabel(goal.status)}</Badge>
            <span>{formatTokenCount(goal.tokensUsed)} tokens</span>
            {goal.tokenBudget && <span>of {formatTokenCount(goal.tokenBudget)}</span>}
            <span>{Math.max(0, Math.round(goal.timeUsedSeconds / 60))}m</span>
          </div>
          {percent !== null && (
            <Progress className="mt-2" value={percent} aria-label={`${percent.toFixed(0)}% of goal token budget used`} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {goal.status === "paused" ? (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void updateStatus("active")} disabled={saving} aria-label="Resume goal"><Play data-icon="inline-start" /></Button>
          ) : goal.status !== "complete" ? (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void updateStatus("paused")} disabled={saving} aria-label="Pause goal"><Pause data-icon="inline-start" /></Button>
          ) : null}
          {goal.status !== "complete" && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void updateStatus("complete")} disabled={saving} aria-label="Mark goal complete"><Check data-icon="inline-start" /></Button>
          )}
          <Button type="button" variant="ghost" size="icon-sm" onClick={beginEditing} aria-label="Edit goal"><Pencil data-icon="inline-start" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => void clearGoal()} disabled={saving} className="text-destructive" aria-label="Clear goal"><Trash2 data-icon="inline-start" /></Button>
        </div>
      </div>
    </section>
  )
}
