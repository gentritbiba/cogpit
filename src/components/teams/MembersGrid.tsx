import { Loader2, Crown, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { shortenModel } from "@/lib/format"
import type { TeamMember, TeamTask } from "@/lib/team-types"
import { getMemberColorClass, getMemberBorderClass } from "@/lib/team-types"

interface MembersGridProps {
  members: TeamMember[]
  tasks: TeamTask[]
  onMemberClick?: (member: TeamMember) => void
}

export function MembersGrid({ members, tasks, onMemberClick }: MembersGridProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {members.map((member) => {
        const activeTask = tasks.find(
          (t) => t.owner === member.name && t.status === "in_progress"
        )
        const isLead = member.agentType === "team-lead"
        const colorDot = getMemberColorClass(isLead ? undefined : member.color)
        const borderClass = getMemberBorderClass(isLead ? undefined : member.color)

        return (
          <button
            key={member.agentId}
            onClick={() => onMemberClick?.(member)}
            className={cn(
              "flex flex-col gap-1.5 rounded-lg border p-3 bg-zinc-900/50 text-left transition-colors group",
              "hover:bg-zinc-800/60 cursor-pointer",
              borderClass
            )}
          >
            {/* Header: dot + name + open icon */}
            <div className="flex items-center gap-2">
              <span
                className={cn("inline-flex h-2.5 w-2.5 shrink-0 rounded-full", colorDot)}
              />
              <span className="text-xs font-medium text-zinc-200 truncate">
                {member.name}
              </span>
              {isLead && (
                <Crown className="size-3 shrink-0 text-yellow-500" />
              )}
              <ExternalLink className="size-3 shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
            </div>

            {/* Role + model */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge
                variant="secondary"
                className="h-4 px-1.5 text-[9px] font-normal"
              >
                {member.agentType}
              </Badge>
              {member.model && (
                <Badge
                  variant="outline"
                  className="h-4 px-1.5 text-[9px] font-normal border-zinc-700 text-zinc-500"
                >
                  {shortenModel(member.model)}
                </Badge>
              )}
            </div>

            {/* Active task */}
            {activeTask && (
              <div className="flex items-center gap-1.5 mt-0.5">
                <Loader2 className="size-3 shrink-0 animate-spin text-blue-400" />
                <span className="text-[10px] text-blue-300 truncate">
                  {activeTask.activeForm || activeTask.subject}
                </span>
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}
