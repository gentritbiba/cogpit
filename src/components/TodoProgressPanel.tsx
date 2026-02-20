import { memo, useState } from "react"
import { ChevronDown, ChevronUp, Circle, CircleCheck, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TodoProgress } from "@/hooks/useTodoProgress"

interface TodoProgressPanelProps {
  progress: TodoProgress
}

export const TodoProgressPanel = memo(function TodoProgressPanel({
  progress,
}: TodoProgressPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const { todos, completed, total } = progress
  const pct = total > 0 ? (completed / total) * 100 : 0

  return (
    <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-900/40">
      {/* Header — always visible */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/30"
      >
        {collapsed ? (
          <ChevronUp className="size-3 text-zinc-500" />
        ) : (
          <ChevronDown className="size-3 text-zinc-500" />
        )}
        <span className="text-[11px] font-medium text-zinc-400">
          TODOs
        </span>
        <span className="text-[10px] font-mono tabular-nums text-zinc-500">
          {completed}/{total}
        </span>

        {/* Progress bar */}
        <div className="flex-1 max-w-[200px]">
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                pct === 100
                  ? "bg-green-500"
                  : "bg-blue-500"
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Active task label */}
        {progress.inProgress && (
          <span className="flex items-center gap-1 text-[10px] text-blue-400 truncate min-w-0">
            <Loader2 className="size-2.5 animate-spin shrink-0" />
            <span className="truncate">{progress.inProgress.activeForm}</span>
          </span>
        )}
      </button>

      {/* Task list — collapsible */}
      {!collapsed && (
        <div className="px-3 pb-2 pt-0.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {todos.map((todo, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 min-w-0"
              >
                {todo.status === "completed" ? (
                  <CircleCheck className="size-3 shrink-0 text-green-500/70" />
                ) : todo.status === "in_progress" ? (
                  <Loader2 className="size-3 shrink-0 text-blue-400 animate-spin" />
                ) : (
                  <Circle className="size-3 shrink-0 text-zinc-600" />
                )}
                <span
                  className={cn(
                    "text-[11px] truncate",
                    todo.status === "completed"
                      ? "text-zinc-500 line-through"
                      : todo.status === "in_progress"
                        ? "text-blue-300"
                        : "text-zinc-400"
                  )}
                >
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
