import { CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

interface PlanApprovalBarProps {
  allowedPrompts?: Array<{ tool: string; prompt: string }>
  onApprove: () => void
  onSend: (message: string) => void
}

export function PlanApprovalBar({ allowedPrompts, onApprove, onSend }: PlanApprovalBarProps) {
  return (
    <Alert className="mb-3 pr-44">
      <CheckCircle />
      <AlertTitle>Plan ready for review</AlertTitle>
      <AlertDescription>
        Approve the plan or ask the agent to revise it.
      </AlertDescription>
      <AlertAction className="flex gap-2">
          <Button
            size="sm"
            onClick={onApprove}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSend("no")}
          >
            Reject
          </Button>
      </AlertAction>
      {allowedPrompts && allowedPrompts.length > 0 && (
        <div className="col-span-full mt-2 flex flex-wrap gap-1">
          <span className="mr-1 self-center text-xs text-muted-foreground">Permissions requested:</span>
          {allowedPrompts.map((p, i) => (
            <Badge key={i} variant="outline">
              {p.prompt}
            </Badge>
          ))}
        </div>
      )}
    </Alert>
  )
}
