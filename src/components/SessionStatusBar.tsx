import { memo, useMemo } from "react"
import { Brain, Zap, GitBranch } from "lucide-react"
import { PullRequestChips } from "@/components/PullRequestChips"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { shortenModel } from "@/lib/format"
import { extractPullRequests, mergePullRequests } from "../../shared/session/prLinks"
import type { ParsedSession } from "@/lib/types"

interface Props {
  session: ParsedSession
  effort?: string
  thinkingEnabled?: boolean
  worktreePath?: string
}

export const SessionStatusBar = memo(function SessionStatusBar({ session, effort, thinkingEnabled, worktreePath }: Props) {
  // The loaded turns only cover the tail of a long session, so the whole-file
  // scan the server already ran for the sidebar backfills anything older.
  const inventory = useSessionInventoryOptional()
  const scanned = inventory?.sessions.find((s) => s.sessionId === session.sessionId)?.pullRequests

  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(session.turns), scanned),
    [session.turns, scanned],
  )

  const hasAny = session.model || effort || thinkingEnabled || worktreePath || session.gitBranch
    || pullRequests.length > 0
  if (!hasAny) return null

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/40 bg-elevation-0/50 text-[11px] font-mono">
      {session.model && <span className="text-foreground/80">{shortenModel(session.model)}</span>}
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
      <div className="ml-auto flex items-center gap-2 min-w-0">
        {session.gitBranch && (
          <span className="text-muted-foreground truncate">{session.gitBranch}</span>
        )}
        <PullRequestChips pullRequests={pullRequests} />
      </div>
    </div>
  )
})
