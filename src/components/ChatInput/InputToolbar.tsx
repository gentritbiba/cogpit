import { Send, Square, Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
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
        <div className="flex items-center gap-1.5 mr-1">
          {elapsedSec > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
              {formatElapsed(elapsedSec)}
            </span>
          )}
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
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
    <div className="flex items-center">
      {/* Interrupt button -- sends a stop request to the active agent */}
      {showAgentControls && (
        <Tooltip>
          <TooltipTrigger render={<Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 rounded-full text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
              onClick={onInterrupt}
              aria-label={interruptLabel}
              title={interruptLabel}
            />}>
              <Square className="size-3 fill-current" />
          </TooltipTrigger>
          <TooltipContent>{interruptLabel} (Esc)</TooltipContent>
        </Tooltip>
      )}

      {/* Stop session -- kills the server process */}
      {showAgentControls && agentKind !== "codex" && (
        <Tooltip>
          <TooltipTrigger render={<Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={onStopSession}
              aria-label="Stop session"
              title="Stop session"
            />}>
              <Power className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Stop session</TooltipContent>
        </Tooltip>
      )}

      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-7 w-7 shrink-0 p-0 rounded-full transition-colors duration-200",
          hasContent
            ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
            : "text-muted-foreground"
        )}
        disabled={!hasContent}
        onClick={onSubmit}
        aria-label={submitLabel}
        title={submitLabel}
      >
        <Send className="size-3.5" />
      </Button>
    </div>
  )
}
