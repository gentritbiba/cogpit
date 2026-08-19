/**
 * The inline Allow/Deny block on a blocked card.
 *
 * The whole point of the grid: answer a permission without opening the session.
 * The server resolves by session id alone, so no session context is needed here.
 */

import { ShieldAlert } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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

const DECISION_BUTTONS: {
  decision: PermissionDecision
  label: string
  variant: "default" | "destructive" | "outline"
}[] = [
  { decision: "allow", label: "Allow", variant: "default" },
  { decision: "deny", label: "Deny", variant: "destructive" },
  { decision: "allow_always", label: "Always", variant: "outline" },
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
    <Alert className="border-warning/40 bg-warning/5">
      <ShieldAlert className="text-warning" />
      <AlertTitle className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {request.title || `Allow ${request.toolName}?`}
        </span>
        {queued > 0 && (
          <span className="shrink-0 font-mono text-xs text-warning">+{queued}</span>
        )}
      </AlertTitle>

      <div className="col-start-2 mt-2 flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {request.toolName}
        </span>
        {request.summary && (
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {request.summary}
          </code>
        )}
      </div>

      {answerable ? (
        <div className="col-start-2 mt-3 flex items-center gap-2">
          {available.map(({ decision, label, variant }) => (
            <Button
              key={decision}
              size="xs"
              variant={variant}
              disabled={responding}
              onClick={() => onRespond(request.requestId, decision)}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="col-start-2 mt-2 text-xs text-warning">
          Resolve this approval in its own provider
        </p>
      )}
    </Alert>
  )
}
