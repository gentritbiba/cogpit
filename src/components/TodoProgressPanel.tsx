import { memo, useState } from "react"
import { ChevronDown, ChevronUp, Circle, CircleCheck, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TodoProgress } from "@/hooks/useTodoProgress"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

interface TodoProgressPanelProps {
  progress: TodoProgress
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

export const TodoProgressPanel = memo(function TodoProgressPanel({
  progress,
  expanded: controlledExpanded,
  onExpandedChange,
}: TodoProgressPanelProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = controlledExpanded ?? internalExpanded

  const { todos, completed, total } = progress
  const pct = total > 0 ? (completed / total) * 100 : 0

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        onExpandedChange?.(next)
        setInternalExpanded(next)
      }}
      className="shrink-0 border-t bg-background"
    >
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" className="h-auto w-full justify-start rounded-none px-3 py-2" />}
      >
        {expanded ? (
          <ChevronDown data-icon="inline-start" />
        ) : (
          <ChevronUp data-icon="inline-start" />
        )}
        <span className="text-sm font-medium">Tasks</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {completed}/{total}
        </span>
        <Progress value={pct} className="max-w-[200px] flex-1" aria-label={`${pct.toFixed(0)}% of tasks complete`} />
        {progress.inProgress && (
          <span className="flex min-w-0 items-center gap-1 truncate text-xs text-info">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">{progress.inProgress.activeForm}</span>
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {todos.map((todo, i) => (
              <div
                key={todo.id ?? i}
                className="flex items-center gap-1.5 min-w-0"
              >
                {todo.status === "completed" ? (
                  <CircleCheck className="size-3 shrink-0 text-success" />
                ) : todo.status === "in_progress" ? (
                  <Loader2 className="size-3 shrink-0 animate-spin text-info" />
                ) : (
                  <Circle className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "truncate text-xs",
                    todo.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground",
                    todo.status === "completed" && "line-through",
                  )}
                >
                  {todo.content}
                </span>
                {todo.owner && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {todo.owner}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
