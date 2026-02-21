import { User, Loader2 } from "lucide-react"

interface PendingTurnPreviewProps {
  message: string
  turnNumber: number
  statusText?: string
  elapsedSec?: number
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

export function PendingTurnPreview({
  message,
  turnNumber,
  statusText = "Agent is working...",
  elapsedSec,
}: PendingTurnPreviewProps) {
  return (
    <div className="group relative py-6 px-4">
      {/* Turn header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-elevation-2 border border-border/70 text-[10px] font-mono text-zinc-400 shrink-0">
          {turnNumber}
        </div>
      </div>

      {/* Timeline content */}
      <div className="ml-3 pl-4 border-l-2 space-y-4 border-border/40">
        {/* User message card */}
        <div className="relative rounded-lg bg-blue-500/[0.06] border border-blue-500/10 p-3">
          <div className="absolute -left-[13px] top-4 w-2.5 h-2.5 rounded-full bg-blue-500/60 ring-2 ring-elevation-1" />
          <div className="flex gap-3">
            <div className="flex-shrink-0 mt-1">
              <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center">
                <User className="w-4 h-4 text-blue-400" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-blue-400">User</span>
                <span className="text-xs text-zinc-500">
                  {new Date().toLocaleTimeString()}
                </span>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-zinc-200 break-words overflow-hidden">
                {message}
              </div>
            </div>
          </div>
        </div>

        {/* Agent working indicator */}
        <div className="flex items-center gap-2 text-zinc-500">
          <Loader2 className="size-3.5 animate-spin text-blue-400" />
          <span className="text-xs">{statusText}</span>
          {elapsedSec !== undefined && elapsedSec > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-zinc-600">
              {formatElapsed(elapsedSec)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
