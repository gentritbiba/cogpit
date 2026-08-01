/**
 * The inline Allow/Deny block on a blocked card.
 *
 * The whole point of the grid: answer a permission without opening the session.
 * The server resolves by session id alone, so no session context is needed here.
 */

import { ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getToolBadgeStyle } from "@/components/timeline/ToolCallCard"
import type { PermissionDecision } from "@/lib/permissionApi"
import type { MissionControlPermission } from "../../../shared/contracts/missionControl"

interface PermissionPromptProps {
  request: MissionControlPermission
  /** Extra requests queued behind this one. */
  queued: number
  responding: boolean
  onRespond: (requestId: string, behavior: PermissionDecision) => void
}

const DEFAULT_DECISIONS: PermissionDecision[] = ["allow", "allow_always", "deny"]

function supports(request: MissionControlPermission, decision: PermissionDecision): boolean {
  return (request.availableDecisions ?? DEFAULT_DECISIONS).includes(decision)
}

export function PermissionPrompt({
  request,
  queued,
  responding,
  onRespond,
}: PermissionPromptProps) {
  const canAllow = supports(request, "allow")
  const canDeny = supports(request, "deny")
  const label = request.title || `Allow ${request.toolName}?`

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.07] p-2">
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-amber-200">
          {label}
        </span>
        {queued > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-amber-400/70">+{queued}</span>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("h-4 shrink-0 px-1.5 py-0 font-mono text-[10px]", getToolBadgeStyle(request.toolName))}
        >
          {request.toolName}
        </Badge>
        {request.summary && (
          <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground/80">
            {request.summary}
          </code>
        )}
      </div>

      {!canAllow && !canDeny ? (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Resolve this approval in its own provider
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          {canAllow && (
            <button
              type="button"
              disabled={responding}
              onClick={() => onRespond(request.requestId, "allow")}
              className="rounded border border-green-600/50 bg-green-600/20 px-2.5 py-1 text-[11px] font-medium text-green-300 transition-colors hover:bg-green-600/35 disabled:opacity-50"
            >
              Allow
            </button>
          )}
          {canDeny && (
            <button
              type="button"
              disabled={responding}
              onClick={() => onRespond(request.requestId, "deny")}
              className="rounded border border-red-700/50 bg-red-600/15 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-600/30 disabled:opacity-50"
            >
              Deny
            </button>
          )}
          {supports(request, "allow_always") && (
            <button
              type="button"
              disabled={responding}
              onClick={() => onRespond(request.requestId, "allow_always")}
              className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Always
            </button>
          )}
        </div>
      )}
    </div>
  )
}
