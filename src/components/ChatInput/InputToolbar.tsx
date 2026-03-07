import type { LucideIcon } from "lucide-react"
import { Send, Square, Mic, MicOff, Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatElapsed } from "@/lib/format"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import { Spinner } from "@/components/ui/Spinner"
import type { VoiceStatus } from "./useVoiceInput"
import { getVoiceButtonClass, getVoiceTooltip } from "./useVoiceInput"

function getVoiceIcon(status: VoiceStatus): LucideIcon | typeof Spinner {
  if (status === "loading") return Spinner
  if (status === "listening") return MicOff
  return Mic
}

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
  voiceStatus: VoiceStatus
  voiceProgress: number
  voiceError: string | null
  onToggleVoice: () => void
  onSubmit: () => void
}

export function ActionButtons({
  hasContent,
  voiceStatus,
  voiceProgress,
  voiceError,
  onToggleVoice,
  onSubmit,
}: ActionButtonsProps) {
  const { isLive, actions: { handleStopSession: onStopSession } } = useSessionContext()
  const { chat: { isConnected, interrupt: onInterrupt } } = useSessionChatContext()
  const showAgentControls = isConnected || isLive

  const VoiceIcon = getVoiceIcon(voiceStatus)

  return (
    <div className="flex items-center">
      {/* Interrupt button -- sends stop request to Claude */}
      {showAgentControls && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 rounded-full text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
              onClick={onInterrupt}
            >
              <Square className="size-3 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Interrupt agent (Esc)</TooltipContent>
        </Tooltip>
      )}

      {/* Stop session -- kills the server process */}
      {showAgentControls && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={onStopSession}
            >
              <Power className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop session</TooltipContent>
        </Tooltip>
      )}

      {/* Voice input button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 w-7 shrink-0 p-0 rounded-full", getVoiceButtonClass(voiceStatus))}
            onClick={onToggleVoice}
            disabled={voiceStatus === "loading"}
          >
            <VoiceIcon className={cn("size-3.5", voiceStatus === "loading" && "mr-0")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {getVoiceTooltip(voiceStatus, voiceProgress, voiceError)}
        </TooltipContent>
      </Tooltip>

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
        aria-label="Send message"
      >
        <Send className="size-3.5" />
      </Button>
    </div>
  )
}
