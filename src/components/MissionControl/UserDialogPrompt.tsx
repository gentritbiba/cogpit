/**
 * The inline answer block for a session parked on a CLI dialog.
 *
 * Only `refusal_fallback_prompt` is rendered, and only because it is declared
 * in the SDK's `supportedDialogKinds`: the CLI never emits a kind the host has
 * not declared, so this component and that list must be extended together.
 */

import { ShieldAlert } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type {
  MissionControlUserDialog,
  UserDialogChoice,
} from "../../../shared/contracts/agentPrompts"

interface UserDialogPromptProps {
  request: MissionControlUserDialog
  responding: boolean
  onChoose: (requestId: string, choice: UserDialogChoice) => void
}

export function UserDialogPrompt({ request, responding, onChoose }: UserDialogPromptProps) {
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <ShieldAlert className="text-warning" />
      <AlertTitle>Claude declined this request</AlertTitle>
      <div className="col-start-2 mt-1 min-w-0">
        <p className="text-sm leading-relaxed text-foreground">
          {request.originalModel} would not answer. Retrying on a fallback model may work.
        </p>
        {request.guidanceText && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {request.guidanceText}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={responding}
            onClick={() => onChoose(request.requestId, "retry_fallback")}
          >
            Retry on {request.fallbackModel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={responding}
            onClick={() => onChoose(request.requestId, "edit_prompt")}
          >
            Edit prompt
          </Button>
          {/* Dismissing is a real answer: it tells the CLI to apply the
              dialog's default rather than wait out its park deadline. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={responding}
            className="ml-auto text-muted-foreground"
            onClick={() => onChoose(request.requestId, "cancelled")}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </Alert>
  )
}
