/**
 * Header entry point for Mission Control, carrying the "needs you" count.
 *
 * The count comes from the shared inventory and pending-input polls, so the
 * badge, the sidebar strip and the grid can never disagree.
 */

import { useMemo } from "react"
import { LayoutGrid } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
import { classifyAttention } from "@/components/LiveSessions/attentionGroups"

interface MissionControlButtonProps {
  active: boolean
  onToggle: () => void
}

function buttonLabel(active: boolean, needsYou: number): string {
  if (active) return "Close Mission Control"
  if (needsYou > 0) return `Mission Control — ${needsYou} need${needsYou === 1 ? "s" : ""} you`
  return "Mission Control"
}

export function MissionControlButton({ active, onToggle }: MissionControlButtonProps) {
  const { sessions, procBySession, newlyCompleted } = useSessionInventory()
  const { awaitingPermission, awaitingQuestion } = usePendingHumanInput()

  const needsYou = useMemo(
    () => classifyAttention(sessions, procBySession, newlyCompleted, awaitingPermission, awaitingQuestion).needsYou.length,
    [sessions, procBySession, newlyCompleted, awaitingPermission, awaitingQuestion],
  )

  const label = buttonLabel(active, needsYou)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={label}
            className={cn(
              "relative",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        <LayoutGrid data-icon="inline-start" />
        {needsYou > 0 && !active && (
          <Badge
            className="absolute -right-1 -top-1 h-4 min-w-4 justify-center bg-warning px-1 py-0 font-mono text-xs text-warning-foreground"
            aria-hidden
          >
            {needsYou}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
