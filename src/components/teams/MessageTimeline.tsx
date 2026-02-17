import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { formatRelativeTime, truncate } from "@/lib/format"
import type { InboxMessage, TeamMember } from "@/lib/team-types"
import { getMemberColorClass, getMemberTextColorClass } from "@/lib/team-types"

interface MessageTimelineProps {
  inboxes: Record<string, InboxMessage[]>
  members: TeamMember[]
}

interface ParsedMessage {
  from: string
  timestamp: string
  color?: string
  type: "chat" | "task_assignment" | "idle" | "shutdown" | "system"
  content: string
  summary?: string
  taskId?: string
  taskSubject?: string
}

function parseInboxMessage(msg: InboxMessage): ParsedMessage {
  const base = {
    from: msg.from,
    timestamp: msg.timestamp,
    color: msg.color,
  }

  // Try JSON parse for structured messages
  try {
    const parsed = JSON.parse(msg.text)
    if (parsed.type === "task_assignment") {
      return {
        ...base,
        type: "task_assignment",
        content: `Assigned task #${parsed.taskId}: ${parsed.subject}`,
        taskId: parsed.taskId,
        taskSubject: parsed.subject,
      }
    }
    if (parsed.type === "idle_notification") {
      return {
        ...base,
        type: "idle",
        content: "Went idle",
      }
    }
    if (parsed.type === "shutdown_request" || parsed.type === "shutdown_response") {
      return {
        ...base,
        type: "shutdown",
        content: parsed.content || `Shutdown ${parsed.type === "shutdown_request" ? "requested" : "response"}`,
      }
    }
    // Other JSON - show as system
    if (parsed.type) {
      return {
        ...base,
        type: "system",
        content: parsed.content || parsed.type,
      }
    }
  } catch {
    // Not JSON, treat as plain text
  }

  return {
    ...base,
    type: "chat",
    content: msg.text,
    summary: msg.summary,
  }
}

export function MessageTimeline({ inboxes, members }: MessageTimelineProps) {
  const memberMap = new Map(members.map((m) => [m.name, m]))

  const messages = useMemo(() => {
    const all: ParsedMessage[] = []
    for (const [, msgs] of Object.entries(inboxes)) {
      for (const msg of msgs) {
        all.push(parseInboxMessage(msg))
      }
    }
    // Sort by timestamp ascending (oldest first)
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    return all
  }, [inboxes])

  if (messages.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-zinc-600">
        No messages yet
      </div>
    )
  }

  // Filter out excessive idle notifications - keep only the first idle per member in a row
  const filtered = messages.filter((msg, i) => {
    if (msg.type !== "idle") return true
    // Keep if previous message from same sender was not idle
    const prev = messages[i - 1]
    if (!prev) return true
    return !(prev.from === msg.from && prev.type === "idle")
  })

  return (
    <div className="flex flex-col gap-0.5">
      {filtered.map((msg, i) => {
        const member = memberMap.get(msg.from)
        const isLead = member?.agentType === "team-lead"
        const colorDot = getMemberColorClass(isLead ? undefined : msg.color)
        const textColor = getMemberTextColorClass(isLead ? undefined : msg.color)
        const isSystemish = msg.type === "idle" || msg.type === "system"

        return (
          <div
            key={`${msg.from}-${msg.timestamp}-${i}`}
            className={cn(
              "flex gap-2 rounded-md px-2 py-1.5 transition-colors",
              isSystemish ? "opacity-40" : "hover:bg-zinc-900/50"
            )}
          >
            {/* Color dot */}
            <span
              className={cn(
                "mt-1 inline-flex h-2 w-2 shrink-0 rounded-full",
                colorDot
              )}
            />

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={cn("text-[11px] font-medium", textColor)}>
                  {msg.from}
                </span>
                <span className="text-[10px] text-zinc-600">
                  {formatRelativeTime(msg.timestamp)}
                </span>
                {msg.type === "task_assignment" && (
                  <span className="text-[9px] text-zinc-600 bg-zinc-800 rounded px-1">
                    task
                  </span>
                )}
                {msg.type === "idle" && (
                  <span className="text-[9px] text-zinc-700 bg-zinc-800/50 rounded px-1">
                    idle
                  </span>
                )}
                {msg.type === "shutdown" && (
                  <span className="text-[9px] text-red-700 bg-red-950/50 rounded px-1">
                    shutdown
                  </span>
                )}
              </div>

              {/* Message body */}
              {msg.type === "chat" ? (
                <div className="mt-0.5 text-xs text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">
                  {msg.content.length > 500 ? (
                    <>
                      {msg.summary && (
                        <p className="text-zinc-300 font-medium mb-1">
                          {msg.summary}
                        </p>
                      )}
                      {truncate(msg.content, 500)}
                    </>
                  ) : (
                    msg.content
                  )}
                </div>
              ) : (
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {msg.content}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
