import { useMemo, memo } from "react"
import {
  FileText,
  MessageSquare,
  GitBranch,
  Copy,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import {
  shortenModel,
  formatFileSize,
  formatRelativeTime,
  truncate,
} from "@/lib/format"
import type { SessionInfo } from "./types"

// ── Props ──────────────────────────────────────────────────────────────────

interface SessionsListProps {
  sessions: SessionInfo[]
  filter: string
  onSelectSession: (s: SessionInfo) => void
  onDuplicateSession?: (s: SessionInfo) => void
  onDeleteSession?: (s: SessionInfo) => void
  isMobile?: boolean
  hasMore?: boolean
  isLoading?: boolean
  onLoadMore?: () => void
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TWO_MINUTES_MS = 120_000

function isRecentlyActive(lastModified: string | null): boolean {
  if (!lastModified) return false
  return Date.now() - new Date(lastModified).getTime() < TWO_MINUTES_MS
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ActivityIndicator(): React.ReactElement {
  return (
    <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-green-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
    </span>
  )
}

function WorktreeBranchLabel({ branch }: { branch: string }): React.ReactElement {
  return (
    <span className="rounded bg-emerald-500/10 text-emerald-400 px-1 py-px text-[9px] font-medium">
      {branch.replace("worktree-", "")}
    </span>
  )
}

function SessionCardMeta({ session }: { session: SessionInfo }): React.ReactElement {
  return (
    <div className="ml-5.5 flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
      {(session.turnCount ?? 0) > 0 && (
        <span className="flex items-center gap-0.5">
          <MessageSquare className="size-2.5" />
          {session.turnCount}
        </span>
      )}
      {session.gitBranch && (
        <span className="flex items-center gap-0.5">
          <GitBranch className="size-2.5" />
          {session.gitBranch.startsWith("worktree-") ? (
            <WorktreeBranchLabel branch={session.gitBranch} />
          ) : (
            session.gitBranch
          )}
        </span>
      )}
      <span>{formatFileSize(session.size)}</span>
      {session.lastModified && (
        <span>{formatRelativeTime(session.lastModified)}</span>
      )}
    </div>
  )
}

function SessionCard({
  session,
  onSelect,
  isMobile,
}: {
  session: SessionInfo
  onSelect: () => void
  isMobile?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "group w-full flex flex-col gap-1 rounded-lg px-2.5 text-left transition-colors elevation-2 depth-low border border-border/40 hover:bg-elevation-3 card-hover",
        isMobile ? "py-3.5" : "py-2.5"
      )}
    >
      {/* Top row: slug or session id + model */}
      <div className="flex items-center gap-2">
        {isRecentlyActive(session.lastModified) ? (
          <ActivityIndicator />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground group-hover:text-blue-400" />
        )}
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {session.slug || truncate(session.sessionId, 16)}
        </span>
        {session.branchedFrom && (
          <Copy className="size-2.5 text-purple-400 shrink-0" title="Duplicated session" />
        )}
        {session.model && (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] font-normal border-border text-muted-foreground shrink-0"
          >
            {shortenModel(session.model)}
          </Badge>
        )}
      </div>

      {/* Preview message */}
      {session.firstUserMessage && (
        <p className="ml-5.5 text-[11px] text-muted-foreground line-clamp-2 leading-snug">
          {session.firstUserMessage}
        </p>
      )}

      {/* Meta row */}
      <SessionCardMeta session={session} />
    </button>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export const SessionsList = memo(function SessionsList({
  sessions,
  filter,
  onSelectSession,
  onDuplicateSession,
  onDeleteSession,
  isMobile,
  hasMore,
  isLoading,
  onLoadMore,
}: SessionsListProps): React.ReactElement {
  const filtered = useMemo(() => {
    if (!filter) return sessions
    const q = filter.toLowerCase()
    return sessions.filter(
      (s) =>
        s.firstUserMessage?.toLowerCase().includes(q) ||
        s.slug?.toLowerCase().includes(q) ||
        s.model?.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
    )
  }, [sessions, filter])

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {filter ? "No matching sessions" : "No sessions found"}
      </div>
    )
  }

  const hasContextMenu = Boolean(onDuplicateSession || onDeleteSession)

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1.5 px-2 pb-3">
        {filtered.map((s) => {
          const card = (
            <SessionCard
              key={s.fileName}
              session={s}
              onSelect={() => onSelectSession(s)}
              isMobile={isMobile}
            />
          )

          if (hasContextMenu) {
            return (
              <SessionContextMenu
                key={s.fileName}
                sessionLabel={s.slug || s.sessionId.slice(0, 12)}
                onDuplicate={onDuplicateSession ? () => onDuplicateSession(s) : undefined}
                onDelete={onDeleteSession ? () => onDeleteSession(s) : undefined}
              >
                {card}
              </SessionContextMenu>
            )
          }

          return card
        })}
        {hasMore && !filter && (
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="mx-2 mt-1 mb-1 rounded-md border border-border/40 elevation-2 depth-low px-3 py-2 text-xs text-muted-foreground hover:bg-elevation-3 hover:text-foreground transition-colors disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load more sessions"}
          </button>
        )}
      </div>
    </ScrollArea>
  )
})
