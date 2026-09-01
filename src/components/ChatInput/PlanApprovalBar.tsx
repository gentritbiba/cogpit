import { CheckCircle, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

interface PlanApprovalBarProps {
  allowedPrompts?: Array<{ tool: string; prompt: string }>
  summary?: string
  planContent?: string
  actions?: string[]
  recommendedAction?: string
  onApprove: (action?: string) => void
  onReject: () => void
}

const ACTION_LABELS: Record<string, string> = {
  exit_only: "Exit plan mode",
  interactive: "Implement interactively",
  autopilot: "Implement with Autopilot",
  autopilot_fleet: "Implement with Fleet",
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll("_", " ")
}

export function PlanApprovalBar({
  allowedPrompts,
  summary,
  planContent,
  actions = [],
  recommendedAction,
  onApprove,
  onReject,
}: PlanApprovalBarProps) {
  const primaryAction = recommendedAction ?? actions[0]
  const alternatives = actions.filter((action) => action !== primaryAction)
  return (
    <Alert className="mb-3 pr-44">
      <CheckCircle />
      <AlertTitle>Plan ready for review</AlertTitle>
      <AlertDescription>
        {summary || "Approve the plan or ask the agent to revise it."}
      </AlertDescription>
      <AlertAction className="flex gap-2">
          <Button
            size="sm"
            onClick={() => onApprove(primaryAction)}
          >
            {primaryAction ? actionLabel(primaryAction) : "Approve"}
          </Button>
          {alternatives.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" variant="outline" size="icon-sm" aria-label="Other plan actions" />}
              >
                <ChevronDown data-icon="icon" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {alternatives.map((action) => (
                    <DropdownMenuItem key={action} onClick={() => onApprove(action)}>
                      {actionLabel(action)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onReject}
          >
            Reject
          </Button>
      </AlertAction>
      {planContent && (
        <Collapsible className="col-span-full mt-2">
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" size="xs" />}
          >
            Review full plan
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-foreground">
              {planContent}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
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
