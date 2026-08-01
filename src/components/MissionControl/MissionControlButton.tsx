/**
 * Header entry point for Mission Control, carrying the "needs you" count.
 *
 * The count comes from the shared session inventory and the shared pending
 * permission poll, so the badge, the sidebar strip and the grid can never
 * disagree about how many sessions are blocked.
 */

import { useMemo } from "react"
import { LayoutGrid } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { usePendingPermissions } from "@/contexts/PendingPermissionsContext"
import { classifyAttention } from "@/components/LiveSessions/attentionGroups"

interface MissionControlButtonProps {
  active: boolean
  onToggle: () => void
}

export function MissionControlButton({ active, onToggle }: MissionControlButtonProps) {
  const { sessions, procBySession, newlyCompleted } = useSessionInventory()
  const { awaiting } = usePendingPermissions()

  const needsYou = useMemo(
    () => classifyAttention(sessions, procBySession, newlyCompleted, awaiting).needsYou.length,
    [sessions, procBySession, newlyCompleted, awaiting],
  )

  const label = active
    ? "Close Mission Control"
    : needsYou > 0
      ? `Mission Control — ${needsYou} need${needsYou === 1 ? "s" : ""} you`
      : "Mission Control"

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
