import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAgentCheck } from "@/hooks/useAgentCheck"
import { AgentCheckView, CheckAgainButton } from "./AgentCheckView"

interface AgentCheckDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The setup screen's agent check, reachable any time from the command palette. */
export function AgentCheckDialog({ open, onOpenChange }: AgentCheckDialogProps) {
  const check = useAgentCheck(open)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Agent setup</DialogTitle>
          <DialogDescription>
            Which coding agents are installed on this computer, and whether you're signed in.
          </DialogDescription>
        </DialogHeader>
        <AgentCheckView check={check} onSignInStarted={() => onOpenChange(false)} />
        <DialogFooter>
          <CheckAgainButton check={check} />
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
