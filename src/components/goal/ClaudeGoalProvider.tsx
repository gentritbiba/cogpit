import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Check, Flag, Pencil, Trash2, X } from "lucide-react"
import type { ParsedSession } from "@/lib/types"
import { extractClaudeGoalState, type ClaudeGoalState } from "@/lib/goals"
import { formatTokenCount } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { GoalContext, type GoalControls } from "./context"
import { GOAL_EDITOR_CLASS, GOAL_PANEL_CLASS } from "./styles"

function statusLabel(status: ClaudeGoalState["status"]): string {
  switch (status) {
    case "active": return "Goal active"
    case "achieved": return "Achieved"
    default: return "Needs attention"
  }
}

function statusVariant(status: ClaudeGoalState["status"]): "secondary" | "destructive" | "outline" {
  switch (status) {
    case "failed": return "destructive"
    case "achieved": return "secondary"
    default: return "outline"
  }
}

interface ClaudeGoalProviderProps {
  session: ParsedSession
  onSendCommand: (command: string) => void
  children: ReactNode
}

export function ClaudeGoalProvider({ session, onSendCommand, children }: ClaudeGoalProviderProps) {
  const parsedGoal = useMemo(
    () => extractClaudeGoalState(session.rawMessages),
    [session.rawMessages],
  )
  const [optimisticGoal, setOptimisticGoal] = useState<ClaudeGoalState | null | undefined>()
  const [editing, setEditing] = useState(false)
  const [condition, setCondition] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Drop the optimistic value once the transcript's own goal changes, i.e. the
  // agent echoed it back. Keying on the parsed goal rather than the message
  // count matters because scrolling up prepends older messages: that grows the
  // count without saying anything new about the goal.
  const parsedGoalKey = parsedGoal ? `${parsedGoal.status}\u0000${parsedGoal.condition}` : ""
  const [seenGoalKey, setSeenGoalKey] = useState(parsedGoalKey)
  if (seenGoalKey !== parsedGoalKey) {
    setSeenGoalKey(parsedGoalKey)
    setOptimisticGoal(undefined)
  }

  const goal = optimisticGoal !== undefined ? optimisticGoal : parsedGoal

  const beginEditing = useCallback(() => {
    setCondition(goal?.condition ?? "")
    setError(null)
    setEditing(true)
  }, [goal])

  const save = () => {
    const next = condition.trim()
    if (!next) return
    if (next.length > 4_000) {
      setError("Goal conditions can be at most 4,000 characters")
      return
    }
    setOptimisticGoal({
      condition: next,
      status: "active",
      iterations: 0,
      durationMs: 0,
      tokens: 0,
    })
    setEditing(false)
    onSendCommand(`/goal ${next}`)
  }

  const clear = () => {
    setOptimisticGoal(null)
    setEditing(false)
    onSendCommand("/goal clear")
  }

  let section: ReactNode = null

  if (editing) {
    section = (
      <section className={GOAL_EDITOR_CLASS} aria-label="Claude goal editor">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Flag className="size-3.5" data-icon="inline-start" />
          {goal ? "Replace goal" : "Set a long-running goal"}
        </div>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel className="sr-only" htmlFor="claude-goal-condition">Goal condition</FieldLabel>
          <Textarea
            id="claude-goal-condition"
            value={condition}
            onChange={(event) => setCondition(event.target.value)}
            placeholder="A measurable condition Claude should keep working toward…"
            rows={2}
            maxLength={4_000}
            aria-invalid={Boolean(error)}
            autoFocus
          />
          <FieldError>{error}</FieldError>
        </Field>
        <div className="mt-2 flex items-center justify-end gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
            <X data-icon="inline-start" />
            Cancel
          </Button>
          <Button type="button" size="xs" onClick={save} disabled={!condition.trim()}>
            <Check data-icon="inline-start" />
            Start goal
          </Button>
        </div>
      </section>
    )
  } else if (goal) {
    section = (
      <section className={GOAL_PANEL_CLASS} aria-label="Claude goal">
        <div className="flex items-center gap-2">
          <Flag className="size-3.5 shrink-0 text-primary" data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={goal.condition}>
            {goal.condition}
          </span>
          <Badge variant={statusVariant(goal.status)}>{statusLabel(goal.status)}</Badge>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {goal.iterations} turn{goal.iterations === 1 ? "" : "s"}
            {" · "}
            {formatTokenCount(goal.tokens)}
            {" · "}
            {Math.max(0, Math.round(goal.durationMs / 60_000))}m
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon-xs" onClick={beginEditing} aria-label="Replace goal">
              <Pencil data-icon="icon" />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" onClick={clear} aria-label="Clear goal">
              <Trash2 data-icon="icon" />
            </Button>
          </div>
        </div>
        {goal.reason && <p className="line-clamp-2 pb-0.5 pl-5 text-xs text-muted-foreground">{goal.reason}</p>}
      </section>
    )
  }

  const controls = useMemo<GoalControls>(
    () => ({ section, canCreate: !goal && !editing, beginEditing }),
    [section, goal, editing, beginEditing],
  )

  return <GoalContext.Provider value={controls}>{children}</GoalContext.Provider>
}
