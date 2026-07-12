import { useEffect, useMemo, useState } from "react"
import { Check, Flag, Pencil, Plus, Trash2, X } from "lucide-react"
import type { AgentKind } from "@/lib/sessionSource"
import type { ParsedSession } from "@/lib/types"
import { extractClaudeGoalState, type ClaudeGoalState } from "@/lib/goals"
import { formatTokenCount } from "@/lib/format"
import { CodexGoalBar } from "@/components/CodexGoalBar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface GoalBarProps {
  agentKind: AgentKind
  session: ParsedSession
  onSendCommand: (command: string) => void
}

function ClaudeGoalBar({ session, onSendCommand }: Omit<GoalBarProps, "agentKind">) {
  const parsedGoal = useMemo(
    () => extractClaudeGoalState(session.rawMessages),
    [session.rawMessages],
  )
  const [optimisticGoal, setOptimisticGoal] = useState<ClaudeGoalState | null | undefined>()
  const [editing, setEditing] = useState(false)
  const [condition, setCondition] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOptimisticGoal(undefined)
  }, [session.rawMessages.length])

  const goal = optimisticGoal !== undefined ? optimisticGoal : parsedGoal

  const beginEditing = () => {
    setCondition(goal?.condition ?? "")
    setError(null)
    setEditing(true)
  }

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

  if (editing) {
    return (
      <section className="mx-3 mb-2 rounded-lg border border-border bg-elevation-2 p-2.5" aria-label="Claude goal editor">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <Flag className="size-3" />
          {goal ? "Replace goal" : "Set a long-running goal"}
        </div>
        <label className="sr-only" htmlFor="claude-goal-condition">Goal condition</label>
        <textarea
          id="claude-goal-condition"
          value={condition}
          onChange={(event) => setCondition(event.target.value)}
          placeholder="A measurable condition Claude should keep working toward…"
          rows={2}
          maxLength={4_000}
          className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          autoFocus
        />
        <div className="mt-2 flex items-center justify-end gap-1">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(false)} aria-label="Cancel goal editing">
            <X />
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={!condition.trim()}>
            <Check data-icon="inline-start" />
            Start goal
          </Button>
        </div>
        {error && <p role="alert" className="mt-1.5 text-[10px] text-destructive">{error}</p>}
      </section>
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

  return (
    <section className="mx-3 mb-2 rounded-lg border border-border bg-elevation-2 px-2.5 py-2" aria-label="Claude goal">
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 size-3 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-foreground" title={goal.condition}>{goal.condition}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground">
            <Badge variant={goal.status === "failed" ? "destructive" : goal.status === "achieved" ? "secondary" : "outline"}>
              {goal.status === "active" ? "Goal active" : goal.status === "achieved" ? "Achieved" : "Needs attention"}
            </Badge>
            <span>{goal.iterations} turn{goal.iterations === 1 ? "" : "s"}</span>
            <span>{formatTokenCount(goal.tokens)} tokens</span>
            <span>{Math.max(0, Math.round(goal.durationMs / 60_000))}m</span>
          </div>
          {goal.reason && <p className="mt-1 line-clamp-2 text-[9px] text-muted-foreground">{goal.reason}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-sm" onClick={beginEditing} aria-label="Replace goal">
            <Pencil />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label="Clear goal">
            <Trash2 />
          </Button>
        </div>
      </div>
    </section>
  )
}

export function GoalBar({ agentKind, session, onSendCommand }: GoalBarProps) {
  return agentKind === "codex"
    ? <CodexGoalBar threadId={session.sessionId} />
    : <ClaudeGoalBar session={session} onSendCommand={onSendCommand} />
}
