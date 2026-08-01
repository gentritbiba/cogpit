/**
 * Header entry point for Mission Control, carrying the "needs you" count.
 *
 * The count comes from the shared inventory and pending-input polls, so the
 * badge, the sidebar strip and the grid can never disagree.
 */

import { useMemo } from "react"
import { LayoutGrid } from "lucide-react"
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
            size="sm"
            onClick={onToggle}
            aria-label={label}
            className={cn(
              "relative h-6 w-6 p-0",
              active ? "bg-blue-500/20" : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <LayoutGrid className={cn("size-4", active && "text-blue-400")} />
        {needsYou > 0 && !active && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-amber-500 px-[3px] font-mono text-[8px] font-bold text-black"
            aria-hidden
          >
            {needsYou}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
