import { memo, useMemo } from "react"
import { Brain, GitBranch } from "lucide-react"
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
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {session.model && <span className="font-medium text-foreground">{shortenModel(session.model)}</span>}
      {effort && (
        <span title="Reasoning effort">{effort}</span>
      )}
      {thinkingEnabled && (
        <span className="flex items-center gap-1">
          <Brain className="size-3" />
          thinking
        </span>
      )}
      {worktreePath && (
        <span className="flex min-w-0 items-center gap-1 truncate">
          <GitBranch className="size-3 shrink-0" />
          {worktreePath}
        </span>
      )}
      {session.gitBranch && (
        <span className="truncate font-mono">{session.gitBranch}</span>
      )}
      <PullRequestChips pullRequests={pullRequests} />
    </div>
  )
})
