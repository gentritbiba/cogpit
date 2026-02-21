import { CheckCircle2, Clock, Play, ArrowRight, Lock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { TeamTask, TeamMember } from "@/lib/team-types"
import { getMemberColorClass } from "@/lib/team-types"

interface TaskBoardProps {
  tasks: TeamTask[]
  members: TeamMember[]
}

type Column = {
  key: "pending" | "in_progress" | "completed"
  label: string
  icon: React.ReactNode
  headerColor: string
  dotColor: string
}

const COLUMNS: Column[] = [
  {
    key: "pending",
    label: "Pending",
    icon: <Clock className="size-3.5" />,
    headerColor: "text-zinc-400",
    dotColor: "bg-zinc-500",
  },
  {
    key: "in_progress",
    label: "In Progress",
    icon: <Play className="size-3.5" />,
    headerColor: "text-blue-400",
    dotColor: "bg-blue-500",
  },
  {
    key: "completed",
    label: "Completed",
    icon: <CheckCircle2 className="size-3.5" />,
    headerColor: "text-green-400",
    dotColor: "bg-green-500",
  },
]

export function TaskBoard({ tasks, members }: TaskBoardProps) {
  const memberMap = new Map(members.map((m) => [m.name, m]))

  const tasksByStatus = {
    pending: tasks.filter((t) => t.status === "pending").sort((a, b) => Number(a.id) - Number(b.id)),
    in_progress: tasks.filter((t) => t.status === "in_progress").sort((a, b) => Number(a.id) - Number(b.id)),
    completed: tasks.filter((t) => t.status === "completed").sort((a, b) => Number(a.id) - Number(b.id)),
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {COLUMNS.map((col) => {
        const colTasks = tasksByStatus[col.key]
        return (
          <div key={col.key} className="flex flex-col gap-2">
            {/* Column header */}
            <div className={cn("flex items-center gap-1.5 text-xs font-medium", col.headerColor)}>
              {col.icon}
              <span>{col.label}</span>
              <Badge
                variant="secondary"
                className="ml-auto h-4 px-1.5 text-[10px] font-normal"
              >
                {colTasks.length}
              </Badge>
            </div>

            {/* Cards */}
            <ScrollArea className="max-h-[500px]">
              <div className="flex flex-col gap-1.5">
                {colTasks.map((task) => {
                  const ownerMember = task.owner ? memberMap.get(task.owner) : null
                  const isBlocked = task.blockedBy.length > 0 &&
                    task.blockedBy.some((id) => {
                      const blocker = tasks.find((t) => t.id === id)
                      return blocker && blocker.status !== "completed"
                    })

                  return (
                    <div
                      key={task.id}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-2.5 transition-colors elevation-2 depth-low card-glow",
                        isBlocked ? "border-yellow-800/40 opacity-70" : "border-border/40"
                      )}
                    >
                      {/* Task ID + subject */}
                      <div className="flex items-start gap-1.5">
                        <span className="shrink-0 text-[10px] font-mono text-zinc-600 mt-0.5">
                          #{task.id}
                        </span>
                        <span className="text-xs text-zinc-300 leading-snug">
                          {task.subject}
                        </span>
                      </div>

                      {/* Owner badge */}
                      {task.owner && (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "inline-flex h-2 w-2 shrink-0 rounded-full",
                              getMemberColorClass(ownerMember?.color)
                            )}
                          />
                          <span className="text-[10px] text-zinc-500">
                            {task.owner}
                          </span>
                        </div>
                      )}

                      {/* Dependency badges */}
                      <div className="flex items-center gap-1 flex-wrap">
                        {isBlocked && (
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[9px] font-normal border-yellow-700/40 text-yellow-500 gap-0.5"
                          >
                            <Lock className="size-2" />
                            Blocked by {task.blockedBy.map((id) => `#${id}`).join(", ")}
                          </Badge>
                        )}
                        {task.blocks.length > 0 && (
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[9px] font-normal border-border/50 text-zinc-500 gap-0.5"
                          >
                            <ArrowRight className="size-2" />
                            Blocks {task.blocks.map((id) => `#${id}`).join(", ")}
                          </Badge>
                        )}
                      </div>
                    </div>
                  )
                })}

                {colTasks.length === 0 && (
                  <div className="py-6 text-center text-[10px] text-zinc-700">
                    No tasks
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        )
      })}
    </div>
  )
}
