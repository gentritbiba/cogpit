import { useState, useEffect, useCallback } from "react"
import { Loader2, RefreshCw, Users, CheckCircle2, Clock, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { formatRelativeTime } from "@/lib/format"
import type { TeamListItem } from "@/lib/team-types"

interface TeamsListProps {
  onSelectTeam: (teamName: string) => void
}

export function TeamsList({ onSelectTeam }: TeamsListProps) {
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [loading, setLoading] = useState(false)

  const fetchTeams = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch("/api/teams")
      const data = await res.json()
      setTeams(data)
    } catch (err) {
      console.error("Failed to fetch teams:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + poll every 10s
  useEffect(() => {
    fetchTeams()
    const interval = setInterval(fetchTeams, 10000)
    return () => clearInterval(interval)
  }, [fetchTeams])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-zinc-400">Teams</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={fetchTeams}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {teams.length === 0 && !loading && (
            <div className="px-3 py-8 text-center text-xs text-zinc-600">
              No teams found
              <p className="mt-1 text-[10px] text-zinc-700">
                Teams appear when created via Claude Code
              </p>
            </div>
          )}

          {loading && teams.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-zinc-500" />
            </div>
          )}

          {teams.map((team) => {
            const { taskSummary: ts } = team
            const progressPct =
              ts.total > 0
                ? Math.round((ts.completed / ts.total) * 100)
                : 0

            return (
              <button
                key={team.name}
                onClick={() => onSelectTeam(team.name)}
                className="group flex flex-col gap-1.5 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-zinc-900 border border-transparent hover:border-zinc-800"
              >
                {/* Top row: icon + name */}
                <div className="flex items-center gap-2">
                  <Users className="size-3.5 shrink-0 text-zinc-500 group-hover:text-blue-400" />
                  <span className="text-xs font-medium text-zinc-300 truncate flex-1">
                    {team.name}
                  </span>
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-[9px] font-normal border-zinc-700 text-zinc-500 shrink-0"
                  >
                    {team.memberCount}
                  </Badge>
                </div>

                {/* Description */}
                {team.description && (
                  <p className="ml-5.5 text-[11px] text-zinc-500 truncate leading-snug">
                    {team.description}
                  </p>
                )}

                {/* Progress bar */}
                {ts.total > 0 && (
                  <div className="ml-5.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-zinc-500 shrink-0">
                      {ts.completed}/{ts.total}
                    </span>
                  </div>
                )}

                {/* Meta row */}
                <div className="ml-5.5 flex items-center gap-2 text-[10px] text-zinc-600 flex-wrap">
                  {ts.inProgress > 0 && (
                    <span className="flex items-center gap-0.5 text-blue-400">
                      <Play className="size-2.5" />
                      {ts.inProgress}
                    </span>
                  )}
                  {ts.pending > 0 && (
                    <span className="flex items-center gap-0.5">
                      <Clock className="size-2.5" />
                      {ts.pending}
                    </span>
                  )}
                  {ts.completed > 0 && (
                    <span className="flex items-center gap-0.5 text-green-500">
                      <CheckCircle2 className="size-2.5" />
                      {ts.completed}
                    </span>
                  )}
                  {team.createdAt > 0 && (
                    <span>
                      {formatRelativeTime(new Date(team.createdAt).toISOString())}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
