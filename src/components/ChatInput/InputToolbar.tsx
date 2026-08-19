import { Send, Square, Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { LiveIndicator } from "@/components/header-shared"
import { cn } from "@/lib/utils"
import { formatElapsed } from "@/lib/format"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { agentKindFromDirName } from "@/lib/sessionSource"

interface InputToolbarProps {
  isPlanApproval: boolean
  isUserQuestion: boolean
  elapsedSec: number
}

export function InputToolbar({
  isPlanApproval,
  isUserQuestion,
  elapsedSec,
}: InputToolbarProps) {
  const { isLive } = useSessionContext()
  const { chat: { isConnected } } = useSessionChatContext()
  const showIndicator = isConnected || isLive

  return (
    <>
      {/* Active session indicator */}
      {showIndicator && !isPlanApproval && !isUserQuestion && (
        <div className="mr-1 flex items-center gap-1.5">
          {elapsedSec > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatElapsed(elapsedSec)}
            </span>
          )}
          <LiveIndicator />
        </div>
      )}
    </>
  )
}

interface ActionButtonsProps {
  hasContent: boolean
  onSubmit: () => void
  submitLabel?: string
}

export function ActionButtons({
  hasContent,
  onSubmit,
  submitLabel = "Send message",
}: ActionButtonsProps) {
  const { isLive, sessionSource, actions: { handleStopSession: onStopSession } } = useSessionContext()
  const { chat: { isConnected, interrupt: onInterrupt } } = useSessionChatContext()
  const showAgentControls = isConnected || isLive
  const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
  const interruptLabel = agentKind === "codex" ? "Stop active turn" : "Interrupt agent"

  return (
    <div className="flex items-center gap-1">
      {/* Interrupt button -- sends a stop request to the active agent */}
      {showAgentControls && (
        <Tooltip>
          <TooltipTrigger render={<Button
              variant="outline"
              size="icon-sm"
              className="shrink-0 rounded-full text-warning"
              onClick={onInterrupt}
              aria-label={interruptLabel}
              title={interruptLabel}
            />}>
              <Square data-icon="inline-start" className="fill-current" />
          </TooltipTrigger>
          <TooltipContent>{interruptLabel} (Esc)</TooltipContent>
        </Tooltip>
      )}

      {/* Stop session -- kills the server process */}
      {showAgentControls && agentKind !== "codex" && (
        <Tooltip>
          <TooltipTrigger render={<Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-full text-destructive"
              onClick={onStopSession}
              aria-label="Stop session"
              title="Stop session"
            />}>
              <Power data-icon="inline-start" />
          </TooltipTrigger>
          <TooltipContent>Stop session</TooltipContent>
        </Tooltip>
      )}

      <Button
        variant={hasContent ? "default" : "secondary"}
        size="icon-sm"
        className={cn("shrink-0 rounded-full", !hasContent && "text-muted-foreground")}
        disabled={!hasContent}
        onClick={onSubmit}
        aria-label={submitLabel}
        title={submitLabel}
      >
        <Send data-icon="inline-start" />
      </Button>
    </div>
  )
}
