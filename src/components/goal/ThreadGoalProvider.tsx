import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Flag, Pause, Pencil, Play, Trash2, X } from "lucide-react"
import { authFetch } from "@/lib/auth"
import type { AgentKind } from "@/lib/agents"
import { threadGoalPath } from "@/lib/agents/goals"
import { agentShortName } from "@/lib/agents/presentation"
import { formatTokenCount } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { GoalContext, type GoalControls } from "./context"
import { GOAL_EDITOR_CLASS, GOAL_PANEL_CLASS } from "./styles"

interface ThreadGoal {
  threadId: string
  objective: string
  status: string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

interface GoalResponse {
  goal: ThreadGoal | null
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

/** Goal controls for an agent that keeps goals on the CLI, behind a proxied thread API. */
export function ThreadGoalProvider({
  agentKind,
  threadId,
  children,
}: { agentKind: AgentKind; threadId: string; children: ReactNode }) {
  const agentName = agentShortName(agentKind)
  const [goal, setGoal] = useState<ThreadGoal | null>(null)
  const [available, setAvailable] = useState(true)
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState("")
  const [tokenBudget, setTokenBudget] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A refresh failure is not worth surfacing: the goal panel keeps showing the
  // last value it had and the next poll retries. `error` is reserved for the
  // edit form, which is the only place it renders.
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await authFetch(threadGoalPath(threadId), { signal })
      if (res.status === 404 || res.status === 501) {
        setAvailable(false)
        return
      }
      if (!res.ok) return
      const data = await res.json() as GoalResponse
      setGoal(data.goal)
      setAvailable(true)
    } catch {
      // Aborted on unmount, or the server is briefly unreachable.
    }
  }, [threadId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    // A 404/501 means this build of the CLI has no goals endpoint, so polling it
    // again never starts working. Stop instead of retrying forever.
    const interval = available ? setInterval(() => void refresh(), 10_000) : undefined
    return () => {
      controller.abort()
      if (interval !== undefined) clearInterval(interval)
    }
  }, [refresh, available])

  const beginEditing = useCallback(() => {
    setObjective(goal?.objective ?? "")
    setTokenBudget(goal?.tokenBudget?.toString() ?? "")
    setError(null)
    setEditing(true)
  }, [goal])

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
      const res = await authFetch(threadGoalPath(threadId), {
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
      const res = await authFetch(threadGoalPath(threadId), {
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
      const res = await authFetch(threadGoalPath(threadId), { method: "DELETE" })
      if (res.ok) {
        setGoal(null)
        setEditing(false)
      }
    } finally {
      setSaving(false)
    }
  }

  const percent = goal?.tokenBudget
    ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
    : null

  let section: ReactNode = null

  if (available && editing) {
    section = (
      <form
        className={GOAL_EDITOR_CLASS}
        onSubmit={(event) => {
          event.preventDefault()
          void saveGoal()
        }}
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Flag className="size-3.5" data-icon="inline-start" />
          {goal ? "Edit long-running goal" : "Set a long-running goal"}
        </div>
        <FieldGroup className="gap-2">
          <Field>
            <FieldLabel className="sr-only" htmlFor="goal-objective">Goal objective</FieldLabel>
            <Textarea
              id="goal-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder={`What should ${agentName} keep working toward?`}
              rows={2}
              autoFocus
            />
          </Field>
          <Field orientation="horizontal" data-invalid={Boolean(error)}>
            <FieldLabel className="text-xs text-muted-foreground" htmlFor="goal-budget">Token budget</FieldLabel>
            <Input
              id="goal-budget"
              type="number"
              min={1}
              step={1}
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
              placeholder="Optional"
              className="ml-auto h-8 w-28"
              aria-invalid={Boolean(error)}
            />
          </Field>
        </FieldGroup>
        <FieldError className="mt-1.5">{error}</FieldError>
        <div className="mt-2 flex items-center justify-end gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
            <X data-icon="inline-start" />
            Cancel
          </Button>
          <Button type="submit" size="xs" disabled={saving || !objective.trim()}>
            <Check data-icon="inline-start" />
            Save goal
          </Button>
        </div>
      </form>
    )
  } else if (available && goal) {
    const isPaused = goal.status === "paused"
    const isComplete = goal.status === "complete"
    section = (
      <section className={GOAL_PANEL_CLASS} aria-label={`${agentName} goal`}>
        <div className="flex items-center gap-2">
          <Flag className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={goal.objective}>
            {goal.objective}
          </span>
          <Badge variant={statusVariant(goal.status)}>{statusLabel(goal.status)}</Badge>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatTokenCount(goal.tokensUsed)}
            {goal.tokenBudget ? ` / ${formatTokenCount(goal.tokenBudget)}` : ""}
            {" · "}
            {Math.max(0, Math.round(goal.timeUsedSeconds / 60))}m
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {isPaused && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void updateStatus("active")}
                disabled={saving}
                aria-label="Resume goal"
              >
                <Play data-icon="icon" />
              </Button>
            )}
            {!isPaused && !isComplete && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void updateStatus("paused")}
                disabled={saving}
                aria-label="Pause goal"
              >
                <Pause data-icon="icon" />
              </Button>
            )}
            {!isComplete && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void updateStatus("complete")}
                disabled={saving}
                aria-label="Mark goal complete"
              >
                <Check data-icon="icon" />
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-xs" onClick={beginEditing} aria-label="Edit goal">
              <Pencil data-icon="icon" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void clearGoal()}
              disabled={saving}
              className="text-destructive"
              aria-label="Clear goal"
            >
              <Trash2 data-icon="icon" />
            </Button>
          </div>
        </div>
        {percent !== null && (
          <Progress className="mt-1 mb-0.5" value={percent} aria-label={`${percent.toFixed(0)}% of goal token budget used`} />
        )}
      </section>
    )
  }

  const controls = useMemo<GoalControls>(
    () => ({ section, canCreate: available && !goal && !editing, beginEditing }),
    [section, available, goal, editing, beginEditing],
  )

  return <GoalContext.Provider value={controls}>{children}</GoalContext.Provider>
}
