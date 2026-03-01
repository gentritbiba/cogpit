import { Send, Square, Mic, MicOff, Loader2, Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatElapsed } from "@/lib/format"
import { useSessionContext, useSessionChatContext } from "@/contexts/SessionContext"
import type { VoiceStatus } from "./useVoiceInput"
import { getVoiceButtonClass, getVoiceTooltip } from "./useVoiceInput"

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
  const { chat: { isConnected } } = useSessionChatContext()

  return (
    <>
      {/* Active session indicator inside textarea */}
      {isConnected && !isPlanApproval && !isUserQuestion && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
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
  const { actions: { handleStopSession: onStopSession } } = useSessionContext()
  const { chat: { isConnected, interrupt: onInterrupt } } = useSessionChatContext()

  return (
    <>
      {/* Interrupt button -- sends Escape to Claude */}
      {isConnected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 shrink-0 p-0 rounded-lg text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
              onClick={onInterrupt}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Interrupt agent (Esc)</TooltipContent>
        </Tooltip>
      )}

      {/* Stop session -- kills the server process */}
      {isConnected && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 shrink-0 p-0 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={onStopSession}
            >
              <Power className="size-4" />
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
            className={cn("h-9 w-9 shrink-0 p-0 rounded-lg", getVoiceButtonClass(voiceStatus))}
            onClick={onToggleVoice}
            disabled={voiceStatus === "loading"}
          >
            {voiceStatus === "loading" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : voiceStatus === "listening" ? (
              <MicOff className="size-4" />
            ) : (
              <Mic className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {getVoiceTooltip(voiceStatus, voiceProgress, voiceError)}
        </TooltipContent>
      </Tooltip>

      {/* Send button */}
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-9 w-9 shrink-0 p-0 rounded-lg transition-colors duration-200",
          hasContent
            ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
            : "text-muted-foreground"
        )}
        disabled={!hasContent}
        onClick={onSubmit}
        aria-label="Send message"
      >
        <Send className="size-4" />
      </Button>
    </>
  )
}
