import { X, HardDrive } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { truncate } from "@/lib/format"
import type { RunningProcess } from "./SessionRow"

function describeProcess(p: RunningProcess): string {
  if (p.args.includes("--continue")) return "interactive (--continue)"
  if (p.args.includes("--resume")) return "resumed session"
  if (p.args.includes("stream-json")) return "persistent (Cogpit)"
  if (p.args.includes("-p ")) {
    const msgMatch = p.args.match(/-p\s+(.{1,60})/)
    return msgMatch?.[1] ? `one-shot: "${truncate(msgMatch[1], 40)}"` : "one-shot (-p)"
  }
  return "interactive"
}

interface ProcessListProps {
  unmatchedProcs: RunningProcess[]
  killingPids: Set<number>
  onKill: (pid: number, e: React.MouseEvent) => void
}

export function ProcessList({ unmatchedProcs, killingPids, onKill }: ProcessListProps) {
  if (unmatchedProcs.length === 0) return null

  return (
    <>
      <div className="px-2.5 pt-3 pb-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Running Processes ({unmatchedProcs.length})
        </span>
      </div>
      {unmatchedProcs.map((p) => (
        <div
          key={p.pid}
          className="group flex items-center gap-2 rounded-lg px-2.5 py-2 elevation-1 border border-border/40 hover:bg-elevation-2 card-hover"
        >
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-foreground truncate">
              {describeProcess(p)}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-0.5">
                    <HardDrive className="size-2.5" />
                    {p.memMB} MB
                  </span>
                </TooltipTrigger>
                <TooltipContent>RAM usage for this process</TooltipContent>
              </Tooltip>
              <span>PID {p.pid}</span>
              <span>{p.tty !== "??" ? p.tty : "bg"}</span>
              <span>{p.startTime}</span>
            </div>
          </div>
          <button
            onClick={(e) => onKill(p.pid, e)}
            disabled={killingPids.has(p.pid)}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 hover:bg-red-500/20 text-muted-foreground hover:text-red-400 disabled:opacity-50"
            title={`Kill PID ${p.pid}`}
            aria-label={`Kill process ${p.pid}`}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </>
  )
}
