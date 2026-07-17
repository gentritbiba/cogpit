import { useCallback, useEffect, useState, memo } from "react"
import { Bot, Clock3, Folder, GitFork, MessageSquare, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { authFetch } from "@/lib/auth"
import { formatFileSize, formatRelativeTime, shortenModel, shortPath, truncate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CodexSubagentInfo } from "./types"

interface Props {
  filter: string
  onSelect: (agent: CodexSubagentInfo) => void
  isMobile?: boolean
}

export const SubagentsList = memo(function SubagentsList({ filter, onSelect, isMobile }: Props): React.ReactElement {
  const [agents, setAgents] = useState<CodexSubagentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadAgents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch("/api/codex-subagents")
      if (!res.ok) throw new Error(`Failed to load subagents (${res.status})`)
      setAgents(await res.json() as CodexSubagentInfo[])
    } catch (err) {
      setAgents([])
      setError(err instanceof Error ? err.message : "Failed to load subagents")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  const query = filter.toLowerCase()
  const filtered = agents.filter((agent) => !query ||
    [agent.firstUserMessage, agent.agentPath, agent.model, agent.sessionId, agent.parentSessionId]
      .some((value) => value?.toLowerCase().includes(query)))

  if (loading) {
    return (
      <Empty className="h-full gap-2 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Bot /></EmptyMedia>
          <EmptyDescription>Loading Codex subagents...</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (error) {
    return (
      <Empty className="h-full gap-3 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Bot /></EmptyMedia>
          <EmptyTitle>Subagents unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => void loadAgents()}>
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </Empty>
    )
  }

  if (filtered.length === 0) {
    return (
      <Empty className="h-full gap-2 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Bot /></EmptyMedia>
          <EmptyTitle>{filter ? "No matching subagents" : "No Codex subagents yet"}</EmptyTitle>
          <EmptyDescription>
            {filter ? "Try a task, project, model, or session ID." : "Delegated Codex sessions will appear here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1.5 px-2 pb-3">
        {filtered.map((agent) => {
          const agentName = agent.agentPath.split("/").filter(Boolean).at(-1)
            || truncate(agent.sessionId, 16)
          return (
            <button
              key={agent.sessionId}
              onClick={() => onSelect(agent)}
              className={cn(
                "group flex w-full flex-col gap-1 rounded-lg px-2.5 text-left transition-colors elevation-2 depth-low hover:bg-elevation-3 card-hover",
                isMobile ? "py-3.5" : "py-2.5"
              )}
            >
              <div className="flex items-center gap-2">
                <Bot className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{agentName}</span>
                {agent.model && (
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] font-normal">
                    {shortenModel(agent.model)}
                  </Badge>
                )}
              </div>
              {agent.firstUserMessage && (
                <p className="ml-5.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {agent.firstUserMessage}
                </p>
              )}
              <div className="ml-5.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span className="flex min-w-0 items-center gap-0.5">
                  <Folder className="size-2.5 shrink-0" />
                  <span className="max-w-28 truncate">{shortPath(agent.cwd, 2)}</span>
                </span>
                <span className="flex items-center gap-0.5">
                  <GitFork className="size-2.5" />
                  {truncate(agent.parentSessionId, 8)}
                </span>
                {!!agent.turnCount && (
                  <span className="flex items-center gap-0.5"><MessageSquare className="size-2.5" />{agent.turnCount}</span>
                )}
                {agent.lastModified && (
                  <span className="flex items-center gap-0.5"><Clock3 className="size-2.5" />{formatRelativeTime(agent.lastModified)}</span>
                )}
                <span>{formatFileSize(agent.size)}</span>
              </div>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
})
