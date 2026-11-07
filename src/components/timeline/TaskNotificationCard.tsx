import { memo } from "react"
import { DisclosureScope, useDisclosure, useDisclosureKey } from "./disclosure"
import { Bell, ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { parseTaskNotifications, type TaskNotification } from "@/lib/userMessageContent"
import { cn } from "@/lib/utils"
import { CompletedIcon, FailedIcon, RunningIcon } from "@/components/ui/StatusIcons"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

const STATUS_STYLES = {
  completed: { Icon: CompletedIcon, color: "text-success", label: "Completed" },
  failed: { Icon: FailedIcon, color: "text-destructive", label: "Failed" },
  error: { Icon: FailedIcon, color: "text-destructive", label: "Error" },
  running: { Icon: RunningIcon, color: "text-warning", label: "Running" },
} as const

const EVENT_STYLE = { Icon: Bell, color: "text-muted-foreground" } as const

/**
 * A background task reporting back, as one line: what it was, how it ended,
 * and its output a click away.
 */
export function TaskNotificationCard({ notification }: { notification: TaskNotification }) {
  const [expanded, setExpanded] = useDisclosure(useDisclosureKey(`task:${notification.taskId}`), false)
  const statusStyle = STATUS_STYLES[notification.status as keyof typeof STATUS_STYLES]
    ?? { ...EVENT_STYLE, label: notification.status || "Event" }
  const { Icon: StatusIcon } = statusStyle
  const hasDetail = notification.result.length > 0 || notification.event.length > 0 || notification.outputFile.length > 0
  const row = (
    <>
      <StatusIcon className={cn("size-3.5 shrink-0", statusStyle.color)} />
      <span className="min-w-0 flex-1 truncate text-foreground/90" title={notification.summary}>{notification.summary}</span>
      <span className={cn("shrink-0 text-xs", statusStyle.color)}>{statusStyle.label}</span>
      {hasDetail && <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
    </>
  )
  const rowClass = "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5"

  if (!hasDetail) return <div data-task-notification className={rowClass}>{row}</div>

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="min-w-0" data-task-notification>
      <CollapsibleTrigger
        render={(
          <button
            type="button"
            aria-label={`${expanded ? "Hide detail" : "Show detail"}: ${notification.summary}`}
            className={cn(rowClass, "transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          />
        )}
      >
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-1 ml-[15px] border-l border-border/60 py-1 pl-4 text-sm text-foreground/90">
          {notification.result && (
            <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
              {notification.result}
            </ReactMarkdown>
          )}
          {notification.event && (
            <div className="whitespace-pre-wrap break-words font-mono text-xs">{notification.event}</div>
          )}
          {notification.outputFile && (
            <div className="mt-2">
              <div className="text-xs font-medium text-muted-foreground">Output file</div>
              <div className="mt-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {notification.outputFile}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The `task_notification` content block: one or more background tasks reporting
 * back mid-turn. The block carries the record verbatim, so the grammar is
 * parsed here rather than in the session core.
 */
export const TaskNotificationBlock = memo(function TaskNotificationBlock({ content }: { content: string }) {
  const { notifications } = parseTaskNotifications(content)
  if (notifications.length === 0) return null
  return (
    <div className="flex flex-col">
      {notifications.map((n, i) => (
        <DisclosureScope key={n.taskId || `notification-${i}`} id={String(i)}>
          <TaskNotificationCard notification={n} />
        </DisclosureScope>
      ))}
    </div>
  )
})
