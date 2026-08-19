import { memo } from "react"
import { Users, Crown, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { TeamMember } from "@/lib/team-types"
import { getMemberColorClass, getMemberEffectiveColor, isTeamLead } from "@/lib/team-types"

interface TeamMembersBarProps {
  teamName: string
  members: TeamMember[]
  currentMemberName?: string | null
  loadingMember?: string | null
  onMemberClick: (member: TeamMember) => void
}

export const TeamMembersBar = memo(function TeamMembersBar({
  teamName,
  members,
  currentMemberName,
  loadingMember,
  onMemberClick,
}: TeamMembersBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b bg-background px-3 py-2">
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Users className="size-3" />
        <span className="max-w-[120px] truncate">{teamName}</span>
      </div>
      <Separator orientation="vertical" className="h-3.5" />
      <div className="flex items-center gap-1">
        {members.map((member) => {
          const isCurrent = member.name === currentMemberName
          const isLoading = member.name === loadingMember
          const colorDot = getMemberColorClass(getMemberEffectiveColor(member))

          return (
            <Button
              key={member.agentId}
              variant="ghost"
              size="xs"
              onClick={() => onMemberClick(member)}
              disabled={isLoading}
              className={cn(
                "whitespace-nowrap",
                isCurrent
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              {isLoading ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <span
                  className={cn(
                    "inline-flex size-1.5 shrink-0 rounded-full",
                    colorDot
                  )}
                />
              )}
              <span>{member.name}</span>
              {isTeamLead(member) && (
                <Crown data-icon="inline-end" className="text-warning" />
              )}
            </Button>
          )
        })}
      </div>
    </div>
  )
})
