import { Users, Crown, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TeamMember } from "@/lib/team-types"
import { getMemberColorClass } from "@/lib/team-types"

interface TeamMembersBarProps {
  teamName: string
  members: TeamMember[]
  currentMemberName?: string | null
  loadingMember?: string | null
  onMemberClick: (member: TeamMember) => void
  onTeamClick?: () => void
}

export function TeamMembersBar({
  teamName,
  members,
  currentMemberName,
  loadingMember,
  onMemberClick,
  onTeamClick,
}: TeamMembersBarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 bg-elevation-1 px-3 py-1.5 shrink-0 overflow-x-auto">
      <button
        onClick={onTeamClick}
        className="flex items-center gap-1.5 shrink-0 text-[11px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Users className="size-3" />
        <span className="max-w-[120px] truncate">{teamName}</span>
      </button>
      <div className="h-3.5 w-px bg-border/50 shrink-0" />
      <div className="flex items-center gap-1">
        {members.map((member) => {
          const isLead = member.agentType === "team-lead"
          const isCurrent = member.name === currentMemberName
          const isLoading = member.name === loadingMember
          const colorDot = getMemberColorClass(isLead ? undefined : member.color)

          return (
            <button
              key={member.agentId}
              onClick={() => onMemberClick(member)}
              disabled={isLoading}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] transition-all whitespace-nowrap",
                isCurrent
                  ? "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30"
                  : "text-zinc-500 hover:bg-elevation-2 hover:text-zinc-300",
                isLoading && "opacity-60"
              )}
            >
              {isLoading ? (
                <Loader2 className="size-2 shrink-0 animate-spin" />
              ) : (
                <span
                  className={cn(
                    "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                    colorDot
                  )}
                />
              )}
              <span>{member.name}</span>
              {isLead && (
                <Crown className="size-2.5 shrink-0 text-yellow-500/70" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
