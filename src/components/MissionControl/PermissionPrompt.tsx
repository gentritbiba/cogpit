/**
 * The inline Allow/Deny block on a blocked card.
 *
 * The whole point of the grid: answer a permission without opening the session.
 * The server resolves by session id alone, so no session context is needed here.
 */

import { ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { getToolTextStyle } from "@/components/timeline/ToolCallCard"
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

const ALLOW = "border-green-600/50 bg-green-600/20 px-2.5 font-medium text-green-300 hover:bg-green-600/35"
const DENY = "border-red-700/50 bg-red-600/15 px-2.5 font-medium text-red-300 hover:bg-red-600/30"
const ALWAYS = "border-border/60 px-2 text-muted-foreground hover:text-foreground"

const DECISION_BUTTONS: { decision: PermissionDecision; label: string; tone: string }[] = [
  { decision: "allow", label: "Allow", tone: ALLOW },
  { decision: "deny", label: "Deny", tone: DENY },
  { decision: "allow_always", label: "Always", tone: ALWAYS },
]

function supports(request: MissionControlPermission, decision: PermissionDecision): boolean {
  return (request.availableDecisions ?? DEFAULT_DECISIONS).includes(decision)
}

export function PermissionPrompt({
  request,
  queued,
  responding,
  onRespond,
}: PermissionPromptProps) {
  const available = DECISION_BUTTONS.filter((button) => supports(request, button.decision))
  // "Always" alone is not an answer — without allow or deny the card cannot
  // resolve the request and has to say so.
  const answerable = available.some((button) => button.decision !== "allow_always")

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.07] p-2">
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-amber-200">
          {request.title || `Allow ${request.toolName}?`}
        </span>
        {queued > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-amber-400/70">+{queued}</span>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className={cn("shrink-0 font-mono text-[10px]", getToolTextStyle(request.toolName))}
        >
          {request.toolName}
        </span>
        {request.summary && (
          <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground/80">
            {request.summary}
          </code>
        )}
      </div>

      {answerable ? (
        <div className="mt-2 flex items-center gap-1.5">
          {available.map(({ decision, label, tone }) => (
            <button
              key={decision}
              type="button"
              disabled={responding}
              onClick={() => onRespond(request.requestId, decision)}
              className={cn(
                "rounded border py-1 text-[11px] transition-colors disabled:opacity-50",
                tone,
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Resolve this approval in its own provider
        </p>
      )}
    </div>
  )
}
