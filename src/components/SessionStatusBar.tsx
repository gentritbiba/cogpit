import { memo } from "react"
import { Brain, Zap, GitBranch } from "lucide-react"
import type { ParsedSession } from "@/lib/types"

interface Props {
  session: ParsedSession
  effort?: string
  thinkingEnabled?: boolean
  worktreePath?: string
}

export const SessionStatusBar = memo(function SessionStatusBar({ session, effort, thinkingEnabled, worktreePath }: Props) {
  const hasAny = session.model || effort || thinkingEnabled || worktreePath || session.gitBranch
  if (!hasAny) return null

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/40 bg-elevation-0/50 text-[11px] font-mono">
      {session.model && <span className="text-foreground/80">{session.model}</span>}
      {effort && (
        <span className="flex items-center gap-1 text-amber-400">
          <Zap className="w-3 h-3" />
          {effort}
        </span>
      )}
      {thinkingEnabled && (
        <span className="flex items-center gap-1 text-purple-400">
          <Brain className="w-3 h-3" />
          thinking
        </span>
      )}
      {worktreePath && (
        <span className="flex items-center gap-1 text-emerald-400 truncate">
          <GitBranch className="w-3 h-3" />
          {worktreePath}
        </span>
      )}
      {session.gitBranch && (
        <span className="text-muted-foreground ml-auto truncate">{session.gitBranch}</span>
      )}
    </div>
  )
})
