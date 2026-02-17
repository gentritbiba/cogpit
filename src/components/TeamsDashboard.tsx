import { useState, useEffect, useCallback } from "react"
import {
  Loader2,
  Users,
  ListTodo,
  MessageSquare,
  ChevronLeft,
  AlertTriangle,
  RefreshCw,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { useTeamLive } from "@/hooks/useTeamLive"
import { MembersGrid } from "@/components/teams/MembersGrid"
import { TaskBoard } from "@/components/teams/TaskBoard"
import { MessageTimeline } from "@/components/teams/MessageTimeline"
import { TeamChatInput } from "@/components/teams/TeamChatInput"
import type { TeamDetail, TeamMember } from "@/lib/team-types"

interface TeamsDashboardProps {
  teamName: string
  onBack: () => void
  onOpenSession?: (dirName: string, fileName: string, memberName?: string) => void
}

export function TeamsDashboard({ teamName, onBack, onOpenSession }: TeamsDashboardProps) {
  const [data, setData] = useState<TeamDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchTeam = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/team-detail/${encodeURIComponent(teamName)}`
      )
      if (!res.ok) {
        setFetchError(`Failed to load team (${res.status})`)
        return
      }
      const detail: TeamDetail = await res.json()
      setData(detail)
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load team")
    } finally {
      setLoading(false)
    }
  }, [teamName])

  // Initial fetch
  useEffect(() => {
    setLoading(true)
    setData(null)
    fetchTeam()
  }, [fetchTeam])

  // SSE live updates - refetch on change
  const { isLive } = useTeamLive(teamName, fetchTeam)

  const handleMemberClick = useCallback(
    async (member: TeamMember) => {
      if (!onOpenSession) return

      try {
        const res = await fetch(
          `/api/team-member-session/${encodeURIComponent(teamName)}/${encodeURIComponent(member.name)}`
        )
        if (!res.ok) return
        const { dirName, fileName } = await res.json()
        onOpenSession(dirName, fileName, member.name)
      } catch {
        // session not found
      }
    },
    [teamName, onOpenSession]
  )

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-500">
        {fetchError ? (
          <>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="size-5 text-red-400" />
            </div>
            <p className="text-sm text-red-400">{fetchError}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => { setFetchError(null); setLoading(true); fetchTeam() }}
              >
                <RefreshCw className="size-3" />
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={onBack}>
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm">Team not found</p>
            <Button variant="outline" size="sm" onClick={onBack}>
              Back
            </Button>
          </>
        )}
      </div>
    )
  }

  const { config, tasks, inboxes } = data
  const completedCount = tasks.filter((t) => t.status === "completed").length
  const totalCount = tasks.length

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl py-4 px-4">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={onBack}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-blue-400 shrink-0" />
                <h2 className="text-sm font-semibold text-zinc-200 truncate">
                  {config.name}
                </h2>
                {isLive && (
                  <Badge
                    variant="outline"
                    className="h-5 px-1.5 text-[10px] font-semibold border-green-700 text-green-400 gap-1"
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                    </span>
                    LIVE
                  </Badge>
                )}
              </div>
              {config.description && (
                <p className="text-xs text-zinc-500 mt-0.5 truncate">
                  {config.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-[10px] font-normal border-zinc-700 text-zinc-400"
              >
                {config.members.length} members
              </Badge>
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-[10px] font-normal border-zinc-700 text-zinc-400"
              >
                {completedCount}/{totalCount} tasks
              </Badge>
            </div>
          </div>

          <Separator className="bg-zinc-800 mb-4" />

          {/* Members Grid */}
          <section className="mb-5">
            <div className="flex items-center gap-1.5 mb-2.5">
              <Users className="size-3.5 text-zinc-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Members
              </h3>
            </div>
            <MembersGrid members={config.members} tasks={tasks} onMemberClick={handleMemberClick} />
          </section>

          <Separator className="bg-zinc-800 mb-5" />

          {/* Task Board */}
          <section className="mb-5">
            <div className="flex items-center gap-1.5 mb-2.5">
              <ListTodo className="size-3.5 text-zinc-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Tasks
              </h3>
            </div>
            <TaskBoard tasks={tasks} members={config.members} />
          </section>

          <Separator className="bg-zinc-800 mb-5" />

          {/* Message Timeline */}
          <section className="mb-8">
            <div className="flex items-center gap-1.5 mb-2.5">
              <MessageSquare className="size-3.5 text-zinc-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Activity
              </h3>
            </div>
            <MessageTimeline inboxes={inboxes} members={config.members} />
          </section>
        </div>
      </ScrollArea>

      {/* Chat input pinned at bottom */}
      <TeamChatInput teamName={teamName} members={config.members} />
    </div>
  )
}
