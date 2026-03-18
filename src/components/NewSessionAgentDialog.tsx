import { Bot, Code2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { shortPath } from "@/lib/format"
import type { AgentKind } from "@/lib/sessionSource"

interface NewSessionAgentDialogProps {
  open: boolean
  cwd: string | null
  onClose: () => void
  onSelect: (agentKind: AgentKind) => void
}

export function NewSessionAgentDialog({
  open,
  cwd,
  onClose,
  onSelect,
}: NewSessionAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-md border-border/30">
        <DialogHeader>
          <DialogTitle>Start New Session</DialogTitle>
          <DialogDescription>
            Choose which agent to use for this project.
            {cwd && <span className="mt-1 block font-mono text-[11px]">{shortPath(cwd)}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto flex-col items-start gap-2 px-4 py-4 text-left"
            onClick={() => onSelect("claude")}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Bot className="size-4 text-blue-400" />
              Claude Code
            </span>
            <span className="text-xs text-muted-foreground">
              Worktrees and MCP controls stay available.
            </span>
          </Button>

          <Button
            type="button"
            variant="outline"
            className="h-auto flex-col items-start gap-2 px-4 py-4 text-left"
            onClick={() => onSelect("codex")}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Code2 className="size-4 text-emerald-400" />
              Codex
            </span>
            <span className="text-xs text-muted-foreground">
              Starts a Codex session for the same working directory.
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
